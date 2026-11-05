import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import { resolveAndApplySecretAssignments } from "./runtime-owner-assignments.js";
import { collectCanonicalSecretInputAssignment, createResolverContext } from "./runtime-shared.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps an unavailable provider cold only in the complete private rehearsal", async () => {
  const root = dirs.make("secret-rehearsal-");
  const ref = { source: "exec", provider: "vault", id: "op://fixture/key" } as const;
  const target: Record<string, unknown> = { apiKey: ref };
  const config: OpenClawConfig = {
    secrets: {
      providers: { vault: { source: "exec", command: path.join(root, "missing-resolver") } },
    },
    plugins: { entries: { fixture: { config: target } } },
  };
  const env: NodeJS.ProcessEnv = {
    ...buildUpdateRehearsalPathEnv(root),
    ...buildUpdateDoctorEnv({
      allowGatewayServiceRepair: false,
      allowGatewayActivation: false,
      serviceRepairPolicy: "external",
    }),
  };
  const before = structuredClone(config);
  const context = createResolverContext({ sourceConfig: config, env });
  const collect = () =>
    collectCanonicalSecretInputAssignment({
      value: target.apiKey,
      path: "plugins.entries.fixture.config.apiKey",
      expected: "string",
      defaults: undefined,
      context,
      apply: (value) => {
        target.apiKey = value;
      },
    });
  collect();
  const result = await resolveAndApplySecretAssignments({
    assignments: context.assignments,
    context,
    options: { config, env },
  });
  expect(result.resolvedValues.size).toBe(0);
  expect(result.degradedOwners).toEqual([
    expect.objectContaining({
      state: "unavailable",
      degradationState: "cold",
      paths: ["plugins.entries.fixture.config.apiKey"],
    }),
  ]);
  expect(context.warnings).toContainEqual(
    expect.objectContaining({ code: "SECRETS_OWNER_UNAVAILABLE" }),
  );
  expect(config).toEqual(before);

  // An incomplete namespace must retain the normal fail-closed runtime policy.
  delete env.OPENCLAW_SKIP_CHANNELS;
  context.assignments.length = 0;
  collect();
  await expect(
    resolveAndApplySecretAssignments({
      assignments: context.assignments,
      context,
      options: { config, env },
      allowOwnerIsolation: true,
    }),
  ).rejects.toThrow();
});

it("keeps malformed SecretRefs fatal during rehearsal", async () => {
  const root = dirs.make("secret-rehearsal-invalid-");
  const env = {
    ...buildUpdateRehearsalPathEnv(root),
    ...buildUpdateDoctorEnv({
      allowGatewayServiceRepair: false,
      allowGatewayActivation: false,
      serviceRepairPolicy: "external",
    }),
  };
  const config: OpenClawConfig = {
    secrets: {
      providers: { vault: { source: "exec", command: path.join(root, "missing-resolver") } },
    },
  };
  const context = createResolverContext({ sourceConfig: config, env });
  collectCanonicalSecretInputAssignment({
    value: { source: "exec", provider: "vault", id: "../key" },
    path: "fixture.apiKey",
    expected: "string",
    defaults: undefined,
    context,
    apply() {},
  });
  await expect(
    resolveAndApplySecretAssignments({
      assignments: context.assignments,
      context,
      options: { config, env },
    }),
  ).rejects.toThrow("Exec secret reference id must match");
});
