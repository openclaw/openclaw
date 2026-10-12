import { afterEach, expect, it } from "vitest";
import { withPreparedToolConstruction } from "../../agents/tool-construction-preparation.js";
import {
  createConfigResolutionFacts,
  getConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../../config/resolution-facts.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotMetadata,
  loadPinnedRuntimeConfigAsync,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSourceSnapshotIfCurrent,
} from "../../config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareReplyToolAuthority, type ReplyToolAuthorityInput } from "./reply-tool-authority.js";

const route = { provider: "openai", model: "test-model" };
const overlay = { senderIsOwner: true, disableTools: false, traceAuthorized: false };

function prepare(config: OpenClawConfig, sessionId: string) {
  let projected: ReplyToolAuthorityInput | undefined;
  const authority = prepareReplyToolAuthority(
    {
      run: {
        ...route,
        config,
        sessionId,
        sessionFile: "/tmp/synthetic-session.json",
        workspaceDir: "/tmp/synthetic-workspace",
        senderIsOwner: true,
      },
    },
    (input) => {
      projected = input;
      return input;
    },
  );
  const fingerprint = authority.project(overlay, route);
  return { authority, fingerprint, config: projected!.run.config! };
}

afterEach(() => clearRuntimeConfigSnapshot());

it("shares reply policy across a generation and pins active turns across publication and reset", () => {
  const config: OpenClawConfig = { tools: { deny: ["exec"] } };
  setRuntimeConfigSnapshot(config);
  const first = prepare(config, "first");
  const second = prepare(config, "second");
  expect(second.config).toBe(first.config);
  expect(second.config).toBe(captureRuntimeConfig(config));
  expect(Object.isFrozen(first.config.tools?.deny)).toBe(true);
  expect(() => first.config.tools!.deny!.push("read")).toThrow(TypeError);

  config.tools!.deny = ["read"];
  setRuntimeConfigSnapshot(config);
  const next = prepare(config, "next");
  expect(next.config).not.toBe(first.config);
  expect(next.fingerprint).not.toBe(first.fingerprint);
  expect(first.authority.project(overlay, route)).toBe(first.fingerprint);
  expect(first.config.tools?.deny).toEqual(["exec"]);

  clearRuntimeConfigSnapshot();
  setRuntimeConfigSnapshot(config);
  expect(prepare(config, "after-reset").config).not.toBe(next.config);
});

it.each(["mutable", "captured", "republished", "async-republished"] as const)(
  "pins provenance when publishing a %s config",
  async (input) => {
    const policy: OpenClawConfig = { tools: { deny: ["exec"] } };
    const config = input === "captured" ? captureRuntimeConfig(policy) : policy;
    setRuntimeConfigSnapshot(config);
    const first = prepare(getRuntimeConfigSnapshot()!, "first");
    const toolConfig = await withPreparedToolConstruction(
      getRuntimeConfigSnapshot()!,
      { env: { HOME: "/tmp/synthetic-home", OPENCLAW_STATE_DIR: "/tmp/synthetic-state" } },
      (facts) => facts.config,
    );
    expect(toolConfig).toBe(first.config);
    if (input === "republished") {
      setRuntimeConfigSnapshot(first.config);
    } else if (input === "async-republished") {
      clearRuntimeConfigSnapshot();
      await loadPinnedRuntimeConfigAsync(async () => ({ config: first.config }));
    }
    const source = structuredClone(config);
    const facts = createConfigResolutionFacts([], new Map([["gateway.auth.token", "TOKEN"]]));
    setConfigResolutionFacts(source, facts);
    expect(
      setRuntimeConfigSourceSnapshotIfCurrent({
        expectedRevision: getRuntimeConfigSnapshotMetadata()!.revision,
        sourceConfig: source,
      }),
    ).toBe(true);
    const next = prepare(getRuntimeConfigSnapshot()!, "next");
    expect(next.config).not.toBe(first.config);
    expect(getConfigResolutionFacts(next.config)).toBe(facts);
    expect(getConfigResolutionFacts(first.config)).toBeNull();
    expect(getConfigResolutionFacts(toolConfig)).toBeNull();
  },
);

it("isolates unpublished scoped configs without sharing later caller edits", () => {
  setRuntimeConfigSnapshot({ tools: { deny: ["write"] } });
  const scoped: OpenClawConfig = { tools: { deny: ["exec"] } };
  const first = prepare(scoped, "first");
  scoped.tools!.deny = ["read"];
  const next = prepare(scoped, "next");
  expect(first.config.tools?.deny).toEqual(["exec"]);
  expect(next.config.tools?.deny).toEqual(["read"]);
  expect(next.fingerprint).not.toBe(first.fingerprint);
  expect(first.authority.project(overlay, route)).toBe(first.fingerprint);
});
