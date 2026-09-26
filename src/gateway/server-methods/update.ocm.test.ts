import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
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
    OPENCLAW_OCM_UPDATE_PROTOCOL: "1",
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

it("hands the authorized operator request to the bound OCM environment and reads the same job", async () => {
  await withManager(async ({ job }) => {
    normalizeUpdateChannelMock.mockReturnValue("beta");
    let response: unknown;
    await invokeUpdateRun(
      {},
      (_ok, value) => {
        response = value;
      },
      { update: { channel: "beta" } },
    );
    expect(response).toMatchObject({ runId: `ocm:${job.id}`, ok: true });
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
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(listUpdateRuns()).toEqual([]);
    job.state = "succeeded";
    job.updatedAt = "2026-09-26T00:00:01Z";
    job.result = { outcome: "up-to-date", runtimeReleaseVersion: "2026.9.6", note: null };
    const respond = vi.fn();
    const { updateHandlers } = await import("./update.js");
    await expectDefined(
      updateHandlers["update.runs.get"],
      "update.runs.get handler",
    )({ params: { runId: `ocm:${job.id}` }, respond } as never);
    expect(respond).toHaveBeenCalledWith(true, {
      run: expect.objectContaining({
        runId: `ocm:${job.id}`,
        status: "skipped",
        reason: "already-current",
        verification: {},
      }),
    });
  });
});

it.each([
  ["source-updated", "succeeded"],
  ["local-command", "skipped"],
] as const)("projects source outcome %s as %s", async (outcome, status) => {
  await withManager(async ({ capability, job }) => {
    capability.bindingKind = "launcher";
    capability.bindingName = "main";
    capability.operations = ["source-upgrade"];
    job.state = "succeeded";
    job.result = { outcome, bindingKind: "launcher", runtimeReleaseVersion: null, note: null };
    const respond = vi.fn();
    await invokeUpdateRun({}, respond);
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ runId: `ocm:${job.id}` }));
    capability.operations = [];
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
        status,
        target: { kind: "git", installationMethod: "ocm" },
      }),
    });
  });
});

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
    const respond = vi.fn();
    await invokeUpdateRun({}, respond);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId: `ocm:${job.id}`,
        handoff: { status: "started" },
      }),
    );
    expect(exec.mock.calls.filter(([, args]) => args[2] === "start")).toHaveLength(1);
  });
});

it.each(["runtime", "launcher", "dev", "none"])(
  "keeps a completed source result unchanged after rebinding to %s",
  async (bindingKind) => {
    await withManager(async ({ capability, job }) => {
      capability.bindingKind = bindingKind;
      job.state = "succeeded";
      job.result = { outcome: "source-updated", runtimeReleaseVersion: null, note: null };
      exec.mockImplementation(async (_command, args) => ({
        stdout: JSON.stringify(
          args[2] === "capabilities"
            ? capability
            : {
                ...job,
                result: { ...job.result, bindingKind: "launcher" },
              },
        ),
        stderr: "",
      }));
      const { updateHandlers } = await import("./update.js");
      const respond = vi.fn();
      await expectDefined(
        updateHandlers["update.runs.get"],
        "update.runs.get handler",
      )({
        params: { runId: `ocm:${job.id}` },
        respond,
      } as never);
      expect(respond).toHaveBeenCalledWith(true, {
        run: expect.objectContaining({
          status: "succeeded",
          target: { kind: "git", installationMethod: "ocm" },
        }),
      });
    });
  },
);

it.each(["launcher", "dev", "none"])(
  "keeps native history and refusal when the %s binding has no update operation or recorded job",
  async (bindingKind) => {
    await withManager(async ({ capability }) => {
      capability.bindingKind = bindingKind;
      capability.operations = ["packaged-upgrade"];
      exec.mockImplementation(async (_command, args) => ({
        stdout: JSON.stringify(args[2] === "capabilities" ? capability : null),
        stderr: "",
      }));
      const run = createUpdateRun({ trigger: "cli" });
      finishUpdateRun(run.runId, { status: "succeeded" });
      const { updateHandlers } = await import("./update.js");
      const respond = vi.fn();
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
      respond.mockClear();
      await invokeUpdateRun({}, respond);
      expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
        result: { reason: "external-supervisor-update-required" },
      });
      expect(exec.mock.calls.some(([, args]) => args[2] === "start")).toBe(false);
    });
  },
);

it.each(["stable", "beta", "extended-stable"] as const)(
  "leaves source channel %s decisions with the native updater",
  async (channel) => {
    await withManager(async ({ capability, job }) => {
      capability.bindingKind = "launcher";
      capability.bindingName = "main";
      capability.operations = ["source-upgrade"];
      normalizeUpdateChannelMock.mockReturnValue(channel);
      const respond = vi.fn();
      await invokeUpdateRun({}, respond, { update: { channel } });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId: `ocm:${job.id}`, handoff: { status: "started" } }),
      );
      const starts = exec.mock.calls.filter(([, args]) => args[2] === "start");
      expect(starts).toHaveLength(1);
      expect(starts[0]?.[1]).not.toContain("--channel");
    });
  },
);

it("reconciles a lost start response by exact request ID without resubmitting", async () => {
  await withManager(async ({ capability, job }) => {
    exec.mockImplementation(async (_command, args) => {
      if (args[2] === "start") {
        job.id = args[args.indexOf("--request-id") + 1]!;
        throw new Error("reply lost");
      }
      return { stdout: JSON.stringify(args[2] === "capabilities" ? capability : job), stderr: "" };
    });
    const respond = vi.fn();
    await invokeUpdateRun({}, respond);
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ runId: `ocm:${job.id}` }));
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
});

it.each(["authority", "scope", "git-target"])(
  "refuses an invalid %s before submitting to OCM",
  async (refusal) => {
    await withManager(async ({ capability }) => {
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
      } else {
        await expect(start()).rejects.toThrow();
      }
      expect(exec.mock.calls.some(([, args]) => args[2] === "start")).toBe(false);
      expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    });
  },
);

it("preserves OCM's admission refusal when no correlated job was created", async () => {
  await withManager(async ({ capability }) => {
    exec.mockImplementation(async (_command, args) => {
      if (args[2] === "capabilities") {
        return { stdout: JSON.stringify(capability), stderr: "" };
      }
      throw new Error(args[2] === "start" ? "Another update is active" : "No such job");
    });
    await expect(invokeUpdateRun({})).rejects.toThrow("Another update is active");
  });
});

it("does not execute a manager selected through config environment values", async () => {
  await withManager(async () => {
    const config = {
      env: { vars: { OCM_SELF: "/trusted/ocm", OPENCLAW_OCM_UPDATE_PROTOCOL: "1" } },
    };
    deleteTestEnvValue("OCM_SELF");
    deleteTestEnvValue("OPENCLAW_OCM_UPDATE_PROTOCOL");
    const rollback = prepareConfigRuntimeEnv({
      previousConfig: {},
      nextConfig: config,
      env: process.env,
    }).publish();
    try {
      const respond = vi.fn();
      await invokeUpdateRun({}, respond, config);
      expect(exec.mock.calls.length).toBe(0);
      expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
        result: { reason: "external-supervisor-update-required" },
      });
    } finally {
      rollback();
    }
  });
});

it("does not pass config-owned host tool overrides into the trusted manager", async () => {
  await withManager(async () => {
    const config = { env: { vars: { OCM_INTERNAL_NPM_BIN: "/config-owned/npm" } } };
    const rollback = prepareConfigRuntimeEnv({
      previousConfig: {},
      nextConfig: config,
      env: process.env,
    }).publish();
    try {
      await invokeUpdateRun({}, undefined, config);
      expect(process.env.OCM_INTERNAL_NPM_BIN).toBe("/config-owned/npm");
      expect(exec.mock.calls.length).toBe(2);
      expect(
        exec.mock.calls.every((call) => {
          const options = call[2];
          return typeof options === "object" && options.baseEnv?.OCM_INTERNAL_NPM_BIN === undefined;
        }),
      ).toBe(true);
    } finally {
      rollback();
    }
  });
});

it("rechecks browser authority after awaiting the manager without an explicit session guard", async () => {
  await withManager(async ({ capability, job }) => {
    let current = true;
    exec.mockImplementation(async (_command, args) => {
      if (args[2] === "capabilities") {
        current = false;
      }
      if (args[2] === "start") {
        job.id = args[args.indexOf("--request-id") + 1]!;
      }
      return { stdout: JSON.stringify(args[2] === "capabilities" ? capability : job), stderr: "" };
    });
    await expect(
      invokeUpdateRun(
        {},
        undefined,
        undefined,
        {},
        {
          hasCurrentClientAuthority: () => current,
        },
      ),
    ).rejects.toThrow("Gateway requester authority changed");
    expect(exec.mock.calls.some(([, args]) => args[2] === "start")).toBe(false);
  });
});

it("keeps source and external-chat requests on the existing refusal path", async () => {
  await withManager(async ({ capability }) => {
    capability.bindingKind = "launcher";
    const respond = vi.fn();
    await invokeUpdateRun({}, respond);
    expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
      result: { reason: "external-supervisor-update-required" },
    });
    capability.bindingKind = "runtime";
    delete capability.bindingName;
    await invokeUpdateRun({}, respond);
    expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
      result: { reason: "external-supervisor-update-required" },
    });
    capability.bindingName = "stable";
    await invokeUpdateRun({ requester: { channel: "slack", senderId: "C0123ABC" } }, respond);
    expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
      result: { reason: "external-supervisor-update-required" },
    });
    expect(exec.mock.calls.some(([, args]) => args[2] === "start")).toBe(false);
  });
});

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
