import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronModelImpactResultSchema } from "../../packages/gateway-protocol/src/schema/cron-model-impact.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as setupRegistry from "../plugins/setup-registry.js";
import { deriveCronModelImpactConfig, resolveCronModelImpact } from "./model-impact.js";
import { impactConfig, impactJob, impactOwner } from "./model-impact.test-support.js";

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

describe("automation model-change impact", () => {
  it("resolves inherited, payload, session, subagent and agent selections without rewriting disabled/expired jobs", async () => {
    const cfg = impactConfig();
    setRuntimeConfigSnapshot(cfg);
    const jobs = [
      impactJob("inherit", { enabled: false }),
      impactJob("payload", {
        payload: { kind: "agentTurn", message: "task", model: "fixture/pinned" },
      }),
      impactJob("session"),
      impactJob("ops", { agentId: "ops" }),
    ];
    const snapshot = JSON.stringify({ cfg, jobs });
    const result = await resolveCronModelImpact({
      cfg,
      input: { model: "fixture/new" },
      jobs,
      ownerForAgent: (id) => impactOwner(cfg, id),
      readSession: async (job) => ({
        available: true,
        entry:
          job.id === "session"
            ? {
                sessionId: "synthetic",
                updatedAt: 1,
                modelOverride: "pinned",
                providerOverride: "fixture",
                modelOverrideSource: "user",
              }
            : undefined,
      }),
    });
    expect(
      result.jobs.map(({ id, before, after, changed, status }) => ({
        id,
        before,
        after,
        changed,
        status,
      })),
    ).toEqual([
      {
        id: "inherit",
        before: { model: "fixture/old", source: "default" },
        after: { model: "fixture/new", source: "default" },
        changed: true,
        status: "no-known-blocker",
      },
      ...["payload", "session", "ops"].map((id) => ({
        id,
        before: { model: "fixture/pinned", source: id === "ops" ? "agent" : id },
        after: { model: "fixture/pinned", source: id === "ops" ? "agent" : id },
        changed: false,
        status: "no-known-blocker",
      })),
    ]);
    expect(Check(CronModelImpactResultSchema, result)).toBe(true);
    expect(JSON.stringify({ cfg, jobs })).toBe(snapshot);
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-key|authorizationId|profileId|inferenceBinding/,
    );
    clearRuntimeConfigSnapshot();
    const subCfg = impactConfig();
    subCfg.agents!.defaults!.subagents = { model: "fixture/pinned" };
    const subagent = await resolveCronModelImpact({
      cfg: subCfg,
      input: { model: "fixture/new" },
      jobs: [impactJob("subagent")],
      ownerForAgent: () => impactOwner(subCfg),
      readSession: async () => ({ available: true }),
    });
    expect(subagent.jobs[0]).toMatchObject({
      after: { model: "fixture/pinned", source: "subagent" },
      changed: false,
    });
  });

  it("previews main/custom policy blockers and provider/account drift without widening or adopting", async () => {
    const cfg = impactConfig();
    cfg.agents!.entries!.main!.modelPolicy = { allow: ["fixture/old"] };
    const jobs = [
      impactJob("main", { sessionTarget: "main" }),
      impactJob("custom", { sessionTarget: "session:workflow" }),
      impactJob("missing-binding", { inferenceBinding: undefined }),
      impactJob("event", {
        sessionTarget: "main",
        inferenceBinding: undefined,
        payload: { kind: "systemEvent", text: "synthetic event" },
      }),
    ];
    const run = (model: string) =>
      resolveCronModelImpact({
        cfg,
        input: { model },
        jobs,
        ownerForAgent: () => impactOwner(cfg),
        readSession: async () => ({ available: true }),
      });
    const result = await run("fixture/new");
    for (const row of result.jobs) {
      expect(row.status).toBe("blocked");
      expect(row.issues).toContainEqual(
        expect.objectContaining({ code: "model-selection-rejected" }),
      );
    }
    expect(result.jobs[2]!.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("no recorded inference account"),
      }),
    );
    expect(result.jobs[3]!.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("no recorded inference account"),
      }),
    );
    const drift = await run("other/new");
    expect(drift.jobs[0]!.issues).toContainEqual(
      expect.objectContaining({ code: "recorded-provider-incompatible" }),
    );
    expect(cfg.agents!.entries!.main!.modelPolicy).toEqual({ allow: ["fixture/old"] });
  });

  it("honors carried selection provenance and captured current runtime", async () => {
    const cfg = impactConfig();
    const entry: SessionEntry = {
      sessionId: "synthetic",
      updatedAt: 1,
      providerOverride: "fixture",
      modelOverride: "pinned",
      modelOverrideSource: "auto",
    };
    const jobs = [impactJob("auto"), impactJob("current", { sessionTarget: "current" })];
    const preview = () =>
      resolveCronModelImpact({
        cfg,
        input: { model: "fixture/new" },
        jobs,
        ownerForAgent: () => impactOwner(cfg),
        readSession: async () => ({ available: true, entry }),
      });
    expect((await preview()).jobs.map((row) => row.after.model)).toEqual([
      "fixture/new",
      "fixture/new",
    ]);
    entry.modelOverrideSource = "user";
    expect((await preview()).jobs.map((row) => row.after.model)).toEqual([
      "fixture/pinned",
      "fixture/new",
    ]);
    expect(
      deriveCronModelImpactConfig(cfg, { agentId: "ops", model: null }).agents!.entries!.ops!.model,
    ).toEqual({});
    expect(cfg.agents!.entries!.ops!.model).toBe("fixture/pinned");
  });

  it("never substitutes another key for a missing bound account and does not misdiagnose private accounts", async () => {
    const cfg = impactConfig();
    const owner = impactOwner(cfg);
    owner.authStore.profiles = {
      "fixture:other": { type: "api_key", provider: "fixture", key: "synthetic-other-key" },
    };
    const bound = impactJob("missing-account");
    const personal = impactJob("private-account", {
      inferenceBinding: {
        ...bound.inferenceBinding!,
        profileId:
          "personal:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002",
      },
    });
    const result = await resolveCronModelImpact({
      cfg,
      input: { model: "fixture/new" },
      jobs: [bound, personal],
      ownerForAgent: () => owner,
      readSession: async () => ({ available: true }),
    });
    expect(result.jobs[0]).toMatchObject({
      status: "blocked",
      issues: [expect.objectContaining({ code: "recorded-account-unavailable" })],
    });
    expect(result.jobs[1]).toMatchObject({
      status: "unknown",
      issues: [expect.objectContaining({ code: "personal-account-observation-unavailable" })],
    });
    expect(JSON.stringify(result)).not.toContain("fixture:other");
  });

  it("does not load setup plugins to infer an unprepared CLI from an account alias", async () => {
    const cfg = impactConfig();
    cfg.agents!.defaults!.models = { "fixture/*": {} };
    cfg.auth = { profiles: { "fixture-cli:work": { provider: "fixture-cli", mode: "oauth" } } };
    const owner = {
      ...impactOwner(cfg),
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture-runtime",
            cliBackends: ["fixture-cli"],
            providerAuthAliases: { "fixture-cli": "fixture" },
          },
        ],
      }),
    };
    const setup = vi.spyOn(setupRegistry, "resolvePluginSetupCliBackend").mockImplementation(() => {
      throw new Error("Preview must not load setup");
    });
    const result = await resolveCronModelImpact({
      cfg,
      input: { model: "fixture/new" },
      jobs: [impactJob("native", { inferenceBinding: undefined })],
      ownerForAgent: () => owner,
      readSession: async () => ({ available: true }),
    });
    expect(result.jobs[0]).toMatchObject({
      status: "unknown",
      issues: [expect.objectContaining({ code: "runtime-support-unknown" })],
    });
    expect(setup).not.toHaveBeenCalled();
  });

  it("reports missing observations as unknown and skips model-independent jobs", async () => {
    const cfg = impactConfig();
    const readSession = vi.fn(async () => ({ available: false }));
    const result = await resolveCronModelImpact({
      cfg,
      input: { model: null },
      jobs: [
        impactJob("cold"),
        impactJob("script", { payload: { kind: "command", argv: ["synthetic"] } }),
      ],
      ownerForAgent: () => undefined,
      readSession,
    });
    expect(result.jobs.map((row) => row.status)).toEqual(["unknown", "not-applicable"]);
    expect(readSession).not.toHaveBeenCalled();
    const unavailable = await resolveCronModelImpact({
      cfg,
      input: { model: "fixture/new" },
      jobs: [impactJob("unreadable")],
      ownerForAgent: () => impactOwner(cfg),
      readSession,
    });
    expect(unavailable.jobs[0]).toMatchObject({ status: "unknown", after: { model: null } });
  });
});
