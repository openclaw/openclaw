import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { prepareConfigRuntimeEnv } from "../../config/config-env-vars.js";
import { resolveConfigPath, resolveStateDir } from "../../config/paths.js";
import { createUpdateRun, finishUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { captureFullEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import {
  invokeUpdateRun,
  normalizeUpdateChannelMock,
  startManagedServiceUpdateHandoffMock,
} from "./update.test-harness.js";

const exec = vi.fn<typeof import("../../process/exec.js").runExec>();

async function withManager(
  run: (fixture: {
    capability: Record<string, unknown>;
    job: {
      id: string;
      envName: string;
      state: string;
      progress: string;
      createdAt: string;
      updatedAt: string;
      result: null | {
        outcome: string;
        bindingKind?: string;
        runtimeReleaseVersion: string | null;
        note: string | null;
      };
      error: string | null;
    };
  }) => Promise<void>,
) {
  const env = captureFullEnv();
  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath();
  const root = path.dirname(stateDir);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, "{}");
  const capability = {
    protocol: "ocm.upgrade-job",
    protocolVersion: 1,
    supported: true,
    envName: "fixture",
    envRoot: root,
    stateDir,
    configPath,
    bindingKind: "runtime",
    bindingName: "stable",
    operations: ["packaged-upgrade"],
    selectors: ["version", "channel", "runtime"],
  };
  const job = {
    id: "fixture-job",
    envName: "fixture",
    state: "running",
    progress: "Preparing update",
    createdAt: "2026-09-26T00:00:00Z",
    updatedAt: "2026-09-26T00:00:00.001Z",
    result: null as null | {
      outcome: string;
      bindingKind?: string;
      runtimeReleaseVersion: string | null;
      note: string | null;
    },
    error: null as string | null,
  };
  for (const [key, value] of Object.entries({
    OPENCLAW_SUPERVISOR_MODE: "external",
    OCM_SELF: "/trusted/ocm",
    OCM_HOME: root,
    OCM_ACTIVE_ENV: "fixture",
    OCM_ACTIVE_ENV_ROOT: root,
  })) {
    setTestEnvValue(key, value);
  }
  exec.mockReset().mockImplementation(async (_command, args) => {
    if (args[2] === "start") {
      job.id = args[args.indexOf("--request-id") + 1]!;
    }
    return { stdout: JSON.stringify(args[2] === "capabilities" ? capability : job), stderr: "" };
  });
  const command = vi
    .spyOn(await import("../../process/exec.js"), "runExec")
    .mockImplementation(exec);
  try {
    await run({ capability, job });
  } finally {
    command.mockRestore();
    env.restore();
  }
}

it.each([
  { binding: "runtime", outcome: "up-to-date", status: "skipped" },
  { binding: "launcher", outcome: "source-updated", status: "succeeded" },
  { binding: "launcher", outcome: "local-command", status: "skipped" },
])(
  "hands off $binding updates and projects $outcome as $status",
  async ({ binding, outcome, status }) => {
    await withManager(async ({ capability, job }) => {
      const source = binding === "launcher";
      capability.bindingKind = binding;
      capability.bindingName = source ? "main" : "stable";
      capability.operations = [source ? "source-upgrade" : "packaged-upgrade"];
      const result = {
        outcome,
        ...(source ? { bindingKind: "launcher" } : {}),
        runtimeReleaseVersion: source ? null : "2026.9.6",
        note: null,
      };
      if (source) {
        job.state = "succeeded";
        job.result = result;
      }
      normalizeUpdateChannelMock.mockReturnValue("beta");
      const respond = vi.fn();
      await invokeUpdateRun({}, respond, { update: { channel: "beta" } });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId: `ocm:${job.id}`, ok: true }),
      );
      const starts = exec.mock.calls.filter(([, args]) => args[2] === "start");
      expect(starts).toHaveLength(1);
      if (source) {
        expect(starts[0]?.[1]).not.toContain("--channel");
        // Recorded source outcomes survive a later runtime rebind and disabled upgrades.
        capability.bindingKind = "runtime";
        capability.operations = [];
      } else {
        expect(exec.mock.calls.map(([executable, args]) => [executable, args])).toContainEqual([
          "/trusted/ocm",
          [
            "upgrade",
            "job",
            "start",
            "fixture",
            "--request-id",
            job.id,
            "--if-binding",
            "runtime:stable",
            "--channel",
            "beta",
            "--json",
          ],
        ]);
      }
      expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(listUpdateRuns()).toEqual([]);
      job.state = "succeeded";
      job.updatedAt = "2026-09-26T00:00:01Z";
      job.result = result;
      const { updateHandlers } = await import("./update.js");
      await expectDefined(
        updateHandlers["update.runs.get"],
        "update.runs.get handler",
      )({
        params: { runId: `ocm:${job.id}` },
        respond,
      } as never);
      expect(respond).toHaveBeenLastCalledWith(true, {
        run: expect.objectContaining({
          runId: `ocm:${job.id}`,
          status,
          verification: {},
          ...(source
            ? { target: { kind: "git", installationMethod: "ocm" } }
            : { reason: "already-current" }),
        }),
      });
    });
  },
);

it("keeps accepted source jobs readable when another source update is unavailable", async () => {
  await withManager(async ({ capability, job }) => {
    capability.bindingKind = "launcher";
    capability.bindingName = "main";
    capability.operations = ["source-upgrade"];
    await invokeUpdateRun({});
    capability.operations = [];
    const { updateHandlers } = await import("./update.js");
    const context = { getRuntimeConfig: () => ({ update: { channel: "dev" } }) };
    for (const [state, field] of [
      ["running", "activeRun"],
      ["failed", "lastRun"],
    ] as const) {
      job.state = state;
      job.error = state === "failed" ? "Source recovery requires the operator" : null;
      const respond = vi.fn();
      await expectDefined(
        updateHandlers["update.status"],
        "update.status handler",
      )({
        params: {},
        respond,
        context,
      } as never);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          [field]: expect.objectContaining({
            runId: `ocm:${job.id}`,
            status: state,
            target: { installationMethod: "ocm" },
          }),
        }),
      );
      respond.mockClear();
      await expectDefined(
        updateHandlers["update.runs.get"],
        "update.runs.get handler",
      )({
        params: { runId: `ocm:${job.id}` },
        respond,
        context,
      } as never);
      expect(respond).toHaveBeenCalledWith(true, {
        run: expect.objectContaining({
          runId: `ocm:${job.id}`,
          status: state,
          target: { installationMethod: "ocm" },
        }),
      });
    }
    const respond = vi.fn();
    await invokeUpdateRun({}, respond);
    expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
      result: { reason: "external-supervisor-update-required" },
    });
    expect(exec.mock.calls.filter(([, args]) => args[2] === "start")).toHaveLength(1);
  });
});

it("hands legacy-supervised source updates to the injected OCM manager", async () => {
  await withManager(async ({ capability, job }) => {
    capability.bindingKind = "launcher";
    capability.bindingName = "main";
    capability.operations = ["source-upgrade"];
    deleteTestEnvValue("OPENCLAW_SUPERVISOR_MODE");
    setTestEnvValue("OPENCLAW_NO_RESPAWN", "1");
    normalizeUpdateChannelMock.mockReturnValue("beta");
    const respond = vi.fn();
    await invokeUpdateRun({}, respond, { update: { channel: "beta" } });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId: `ocm:${job.id}`,
        handoff: { status: "started" },
      }),
    );
    const starts = exec.mock.calls.filter(([, args]) => args[2] === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.[1]).not.toContain("--channel");
  });
});

it.each(["launcher", "none", "unbound", "external-chat"])(
  "preserves native history and update refusal for %s",
  async (bindingKind) => {
    await withManager(async ({ capability }) => {
      capability.bindingKind =
        bindingKind === "unbound" || bindingKind === "external-chat" ? "runtime" : bindingKind;
      capability.operations = ["packaged-upgrade"];
      if (bindingKind === "unbound") {
        delete capability.bindingName;
      }
      exec.mockImplementation(async (_command, args) => ({
        stdout: JSON.stringify(args[2] === "capabilities" ? capability : null),
        stderr: "",
      }));
      const run = createUpdateRun({ trigger: "cli" });
      finishUpdateRun(run.runId, { status: "succeeded" });
      const { updateHandlers } = await import("./update.js");
      const respond = vi.fn();
      if (bindingKind !== "external-chat") {
        await expectDefined(
          updateHandlers["update.status"],
          "update.status handler",
        )({
          params: {},
          respond,
          context: { getRuntimeConfig: () => ({ update: { channel: "dev" } }) },
        } as never);
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            lastRun: expect.objectContaining({ runId: run.runId, status: "succeeded" }),
          }),
        );
      }
      respond.mockClear();
      await invokeUpdateRun(
        bindingKind === "external-chat"
          ? { requester: { channel: "slack", senderId: "C0123ABC" } }
          : {},
        respond,
      );
      expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
        result: { reason: "external-supervisor-update-required" },
      });
      expect(exec.mock.calls.some(([, args]) => args[2] === "start")).toBe(false);
    });
  },
);

it.each([true, false])(
  "reconciles a failed start without resubmitting (job exists=%s)",
  async (exists) => {
    await withManager(async ({ capability, job }) => {
      exec.mockImplementation(async (_command, args) => {
        if (args[2] === "start") {
          job.id = args[args.indexOf("--request-id") + 1]!;
          throw new Error(exists ? "reply lost" : "Another update is active");
        }
        if (!exists && args[2] !== "capabilities") {
          throw new Error("No such job");
        }
        return {
          stdout: JSON.stringify(args[2] === "capabilities" ? capability : job),
          stderr: "",
        };
      });
      const respond = vi.fn();
      if (exists) {
        await invokeUpdateRun({}, respond);
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ runId: `ocm:${job.id}` }),
        );
      } else {
        await expect(invokeUpdateRun({})).rejects.toThrow("Another update is active");
      }
      expect(exec.mock.calls.filter(([, args]) => args[2] === "start")).toHaveLength(1);
      expect(exec.mock.calls.at(-1)?.[1]).toEqual([
        "upgrade",
        "job",
        "status",
        "fixture",
        "--request-id",
        job.id,
        "--json",
      ]);
    });
  },
);

it.each(["authority", "browser-authority", "scope", "git-target"])(
  "refuses an invalid %s before submitting to OCM",
  async (refusal) => {
    await withManager(async ({ capability, job }) => {
      let current = true;
      if (refusal === "browser-authority") {
        exec.mockImplementation(async (_command, args) => {
          if (args[2] === "capabilities") {
            current = false;
          }
          if (args[2] === "start") {
            job.id = args[args.indexOf("--request-id") + 1]!;
          }
          return {
            stdout: JSON.stringify(args[2] === "capabilities" ? capability : job),
            stderr: "",
          };
        });
      }
      if (refusal === "scope") {
        capability.envName = "another-env";
      }
      const start = () =>
        invokeUpdateRun(
          refusal === "git-target"
            ? { target: { kind: "git", upstreamRef: "origin/main", upstreamSha: "a".repeat(40) } }
            : {},
          undefined,
          undefined,
          {},
          {
            hasCurrentClientAuthority: refusal === "browser-authority" ? () => current : undefined,
            sessionMutationCommitGuard:
              refusal === "authority"
                ? () => {
                    throw new Error("revoked");
                  }
                : undefined,
          },
        );
      if (refusal === "git-target") {
        await start();
      } else if (refusal === "browser-authority") {
        await expect(start()).rejects.toThrow("Gateway requester authority changed");
      } else {
        await expect(start()).rejects.toThrow();
      }
      expect(exec.mock.calls.some(([, args]) => args[2] === "start")).toBe(false);
      expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    });
  },
);

it.each([
  ["OCM_SELF", "/trusted/ocm"],
  ["OCM_INTERNAL_NPM_BIN", "/config-owned/npm"],
] as const)("excludes config-owned %s from the trusted manager environment", async (key, value) => {
  await withManager(async () => {
    const config = { env: { vars: { [key]: value } } };
    if (key === "OCM_SELF") {
      deleteTestEnvValue(key);
    }
    const rollback = prepareConfigRuntimeEnv({
      previousConfig: {},
      nextConfig: config,
      env: process.env,
    }).publish();
    try {
      const respond = vi.fn();
      await invokeUpdateRun({}, respond, config);
      if (key === "OCM_SELF") {
        expect(exec.mock.calls.length).toBe(0);
        expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
          result: { reason: "external-supervisor-update-required" },
        });
      } else {
        expect(process.env.OCM_INTERNAL_NPM_BIN).toBe("/config-owned/npm");
        expect(exec.mock.calls.length).toBe(2);
        expect(
          exec.mock.calls.every((call) => {
            const options = call[2];
            return (
              typeof options === "object" && options.baseEnv?.OCM_INTERNAL_NPM_BIN === undefined
            );
          }),
        ).toBe(true);
      }
    } finally {
      rollback();
    }
  });
});

it.each(["home-only", "self-only", "env-exec", "incomplete"])(
  "does not probe a manager with %s context",
  async (context) => {
    await withManager(async () => {
      if (context === "incomplete") {
        deleteTestEnvValue("OCM_ACTIVE_ENV_ROOT");
      } else if (context === "env-exec") {
        deleteTestEnvValue("OCM_SELF");
      } else {
        deleteTestEnvValue("OCM_ACTIVE_ENV");
        deleteTestEnvValue("OCM_ACTIVE_ENV_ROOT");
        deleteTestEnvValue(context === "home-only" ? "OCM_SELF" : "OCM_HOME");
      }
      const respond = vi.fn();
      if (context === "incomplete") {
        await expect(invokeUpdateRun({})).rejects.toThrow("OCM update binding is incomplete");
        expect(listUpdateRuns()).toEqual([]);
      } else {
        await invokeUpdateRun({}, respond);
        expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
          result: { reason: "external-supervisor-update-required" },
        });
      }
      expect(exec).not.toHaveBeenCalled();
    });
  },
);

it("preserves native read-only history with an older manager while refusing managed writes and reads", async () => {
  await withManager(async () => {
    normalizeUpdateChannelMock.mockReturnValue("dev");
    exec.mockRejectedValue(
      Object.assign(new Error("Command exited with code 1"), {
        failed: true,
        exitCode: 1,
        stdout: "",
        stderr:
          'ocm: unexpected arguments: capabilities fixture\nRun "/trusted/ocm help" for usage.\n',
      }),
    );
    const run = createUpdateRun({ trigger: "cli" });
    finishUpdateRun(run.runId, { status: "succeeded" });
    const { updateHandlers } = await import("./update.js");
    const respond = vi.fn();
    const context = { getRuntimeConfig: () => ({ update: { channel: "dev" } }) };
    await expectDefined(
      updateHandlers["update.status"],
      "update.status handler",
    )({
      params: {},
      respond,
      context,
    } as never);
    expect(respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({
        effectiveChannel: "dev",
        lastRun: expect.objectContaining({ runId: run.runId, status: "succeeded" }),
      }),
    );
    await expectDefined(
      updateHandlers["update.runs.list"],
      "update.runs.list handler",
    )({
      params: {},
      respond,
    } as never);
    expect(respond).toHaveBeenLastCalledWith(true, {
      runs: [expect.objectContaining({ runId: run.runId })],
    });
    const get = expectDefined(updateHandlers["update.runs.get"], "update.runs.get handler");
    await get({ params: { runId: run.runId }, respond } as never);
    expect(respond).toHaveBeenLastCalledWith(true, {
      run: expect.objectContaining({ runId: run.runId }),
    });
    await expect(get({ params: { runId: "ocm:missing" }, respond } as never)).rejects.toThrow(
      "OCM update capabilities",
    );
    await expect(invokeUpdateRun({})).rejects.toThrow("OCM update capabilities");
    expect(exec.mock.calls.every(([, args]) => args[2] === "capabilities")).toBe(true);
    expect(listUpdateRuns()).toHaveLength(1);
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  });
});

it.each(["timeout", "authentication", "malformed", "binding", "identity", "job-read"])(
  "keeps a manager %s failure visible to read-only status",
  async (failure) => {
    await withManager(async ({ capability }) => {
      if (failure === "identity") {
        deleteTestEnvValue("OCM_ACTIVE_ENV_ROOT");
      } else if (failure === "binding") {
        capability.stateDir = path.dirname(resolveStateDir());
      } else if (failure === "malformed") {
        capability.protocolVersion = 99;
      } else {
        exec.mockImplementation(async (_command, args) => {
          if (failure === "job-read" && args[2] === "capabilities") {
            return { stdout: JSON.stringify(capability), stderr: "" };
          }
          throw Object.assign(new Error("Manager unavailable"), {
            failed: true,
            exitCode: 1,
            timedOut: failure === "timeout",
            stdout: "",
            stderr:
              failure === "authentication"
                ? "OCM authentication failed"
                : 'ocm: unexpected arguments: capabilities fixture\nRun "/trusted/ocm help" for usage.\n',
          });
        });
      }
      const { updateHandlers } = await import("./update.js");
      const respond = vi.fn();
      await expect(
        expectDefined(
          updateHandlers["update.status"],
          "update.status handler",
        )({
          params: {},
          respond,
        } as never),
      ).rejects.toThrow();
      expect(respond).not.toHaveBeenCalled();
    });
  },
);

it("redacts manager diagnostics before RPC/UI projection and probe errors", async () => {
  await withManager(async ({ job }) => {
    const secret = "fixture-ocm-only-not-a-secret-12345";
    const diagnostic = `Package fetch failed: https://example.invalid/pkg?token=${secret}`;
    job.state = "failed";
    job.error = diagnostic;
    const { updateHandlers } = await import("./update.js");
    const respond = vi.fn<(ok: boolean, value?: { run: UpdateRunRecord }) => void>();
    await expectDefined(
      updateHandlers["update.runs.get"],
      "update.runs.get handler",
    )({ params: { runId: `ocm:${job.id}` }, respond } as never);
    const response = expectDefined(respond.mock.calls[0]?.[1], "managed update response");
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(renderUpdateRunReport(response.run).markdown).toContain("Package fetch failed");
    expect(renderUpdateRunReport(response.run).markdown).not.toContain(secret);
    exec.mockRejectedValue(new Error(diagnostic));
    const error = await invokeUpdateRun({}).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).toContain("Package fetch failed");
  });
});
