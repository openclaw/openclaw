import { afterEach, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveRepositoryConnectionIdentity } from "../gateway/github-user-identity.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { getRepositoryIntegration } from "./repository-integration-runtime.js";
import type { RepositoryIntegration } from "./repository-integration.types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

const policy: RepositoryIntegration = {
  version: 1,
  preparedCapacity: "image",
  resolveConnectionIdentity: () => undefined,
  withIdentity: async (context, run) =>
    await run({
      env: context.env,
      assertCurrent: () => context.assertCurrent(),
      readNativeCredential: async () => undefined,
    }),
};
function fixture() {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "repository-policy",
    source: "synthetic-policy",
    origin: "workspace",
    enabled: true,
    configSchema: false,
  });
  record.contracts = { repositoryIntegrations: ["repository"] };
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  setActivePluginRegistry(builder.registry);
  setRuntimeConfigSnapshot({ gateway: { repositoryIntegration: record.id } });
  return { builder, record, api, instance: getPluginInstance(record)! };
}
afterEach(() => {
  resetPluginRuntimeStateForTest();
  setRuntimeConfigSnapshot({});
});

it("uses native behavior with no repository policy declaration", () => {
  const builder = createTestPluginRegistry();
  setActivePluginRegistry(builder.registry);
  expect(getRepositoryIntegration()).toBeUndefined();
});
it("a selected owner cannot fall back before its registry or manifest is available", () => {
  resetPluginRuntimeStateForTest();
  setRuntimeConfigSnapshot({ gateway: { repositoryIntegration: "required-policy" } });
  expect(() => getRepositoryIntegration()).toThrow("unavailable");
});
it.each([
  "unregistered",
  "load-error",
  "duplicate-owner",
  "disabled",
  "missing-manifest",
  "missing-declaration",
])("required %s policy cannot fall back", (scenario) => {
  const f = fixture();
  if (scenario !== "unregistered") {
    f.api.registerRepositoryIntegration(policy);
  }
  if (scenario === "load-error") {
    f.record.status = "error";
  }
  if (scenario === "disabled") {
    f.record.enabled = false;
  }
  if (scenario === "missing-manifest") {
    f.builder.registry.plugins.length = 0;
  }
  if (scenario === "missing-declaration") {
    delete f.record.contracts;
  }
  if (scenario === "duplicate-owner") {
    f.builder.registry.plugins.push({ ...f.record });
  }
  expect(() => getRepositoryIntegration()).toThrow();
});
it("a registered policy and retained returned callbacks lose authority on instance disposal", async () => {
  const f = fixture();
  f.api.registerRepositoryIntegration(policy);
  const integration = getRepositoryIntegration()!;
  let retained: (() => void) | undefined;
  await integration.withIdentity(
    {
      actor: {
        profileId: "profile",
        sessionKey: "session",
        authorization: { kind: "admitted-operation" },
        assertCurrent() {},
      },
      operation: {
        purpose: "session-dispatch-project",
        binding: {
          kind: "session-dispatch",
          agentId: "main",
          sessionKey: "session",
          sessionId: "physical-session",
          requestDigest: "query",
        },
      },
      env: {},
      host: "github.example.test",
      apiBaseUrl: "https://api.github.example.test",
      readCurrentProfile: () => ({ emails: ["person@example.test"] }),
      assertCurrent() {},
    },
    async (scope) => {
      retained = scope.assertCurrent;
      retained();
    },
  );
  await f.instance.dispose();
  expect(() =>
    integration.resolveConnectionIdentity({
      authentication: { ok: true },
      headers: {},
      host: "github.example.test",
      assertCurrent() {},
    }),
  ).toThrow();
  expect(() => retained!()).toThrow();
  expect(() => getRepositoryIntegration()).toThrow();
});

it.each([false, true])(
  "connection identity cannot escape a changed policy owner (%s)",
  (replaceOwner) => {
    const f = fixture();
    const identity = {
      accountId: 42,
      credentialSource: { id: "synthetic-lease", expiresAtMs: 123456 },
    };
    f.api.registerRepositoryIntegration({
      ...policy,
      resolveConnectionIdentity(context) {
        expect(context.authentication).toMatchObject({
          ok: true,
          method: "trusted-proxy",
          user: "authenticated-person",
        });
        context.assertCurrent();
        if (replaceOwner) {
          f.record.status = "error";
        }
        return identity;
      },
    });
    const resolve = () =>
      resolveRepositoryConnectionIdentity({
        authResult: { ok: true, method: "trusted-proxy", user: "authenticated-person" },
        requestHeaders: {},
        assertCurrent() {},
      });
    if (replaceOwner) {
      expect(resolve).toThrow("unavailable");
    } else {
      expect(resolve()).toEqual({
        accountId: 42,
        credentialSource: { id: "synthetic-lease", expiresAtMs: 123456 },
      });
    }
  },
);
