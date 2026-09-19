import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  resolveEntrypoint: vi.fn(),
  runExec: vi.fn(),
  convergeCandidate: vi.fn(),
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfig,
}));
vi.mock("../../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.resolveEntrypoint,
}));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runExec: mocks.runExec,
  runUtf8CommandWithTimeout: async ([command, ...args]: string[], options: unknown) => ({
    ...(await mocks.runExec(command, args, options)),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  }),
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  readPackageVersion: vi.fn(async () => "2026.9.4"),
  resolveNodeRunner: vi.fn(() => "/usr/bin/node"),
}));
vi.mock("./update-command-resume.js", () => ({
  convergePostCoreUpdatePlugins: mocks.convergeCandidate,
}));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: vi.fn(), log: vi.fn() },
}));

import { convergeUpdatePlugins } from "./update-command-convergence.js";

const snapshot: ConfigFileSnapshot = {
  path: "/isolated/openclaw.json",
  exists: true,
  raw: "{}",
  valid: true,
  parsed: {},
  sourceConfig: {},
  resolved: {},
  runtimeConfig: {},
  config: {},
  warnings: [],
  issues: [],
  legacyIssues: [],
};
const pluginUpdate: PostCorePluginUpdateResult = {
  status: "ok",
  changed: true,
  sync: {
    changed: false,
    switchedToBundled: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
  warnings: [],
};

beforeEach(() => {
  mocks.readConfig.mockReset().mockResolvedValue(snapshot);
  mocks.resolveEntrypoint.mockReset().mockResolvedValue("/isolated/dist/index.js");
  mocks.convergeCandidate.mockReset().mockResolvedValue({ pluginUpdate, configSnapshot: snapshot });
  mocks.runExec.mockReset().mockImplementation(async (_command, args: string[]) => ({
    stdout: args.includes("--lint")
      ? JSON.stringify({ ok: true, checksRun: 1, checksSkipped: 0, findings: [] })
      : "",
    stderr: "",
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe("candidate convergence Doctor dispatch authority", () => {
  it.each([
    "live",
    "entrypoint-revocation",
    "maintenance-replacement",
    "doctor-revocation",
    "config-read-revocation",
    "validation-replacement",
    "entrypoint-first-refusal",
    "maintenance-first-refusal",
  ] as const)("does not dispatch fresh Doctor with stale authority after %s", async (boundary) => {
    const originalOwner = {};
    let currentOwner: object | undefined = originalOwner;
    const stale = new Error("original updater is no longer current");
    let refusalArmed = false;
    let refusedOnce = false;
    const assertCurrent = () => {
      if (refusalArmed && !refusedOnce) {
        refusedOnce = true;
        throw stale;
      }
      if (currentOwner !== originalOwner) {
        throw stale;
      }
    };
    if (boundary === "entrypoint-revocation" || boundary === "entrypoint-first-refusal") {
      mocks.resolveEntrypoint.mockImplementationOnce(async () => {
        await Promise.resolve();
        if (boundary === "entrypoint-first-refusal") {
          refusalArmed = true;
        } else {
          currentOwner = undefined;
        }
        return "/isolated/dist/index.js";
      });
    }
    const dispatched: string[] = [];
    mocks.runExec.mockImplementation(async (_command, args: string[]) => {
      const operation = args.includes("--repair")
        ? "repair"
        : args.includes("--lint")
          ? "readiness"
          : "validate";
      dispatched.push(operation);
      await Promise.resolve();
      if (boundary === "doctor-revocation" && operation === "repair") {
        currentOwner = undefined;
      }
      if (boundary === "validation-replacement" && operation === "validate") {
        currentOwner = {};
      }
      return {
        stdout:
          operation === "readiness"
            ? JSON.stringify({ ok: true, checksRun: 1, checksSkipped: 0, findings: [] })
            : "",
        stderr: "",
      };
    });
    if (boundary === "config-read-revocation") {
      mocks.readConfig.mockImplementationOnce(async () => {
        await Promise.resolve();
        currentOwner = undefined;
        return snapshot;
      });
    }
    const outcome = convergeUpdatePlugins({
      candidateRuntime: true,
      result: { status: "ok", mode: "npm", root: "/isolated", steps: [], durationMs: 0 },
      root: "/isolated",
      installKindChanged: false,
      configSnapshot: snapshot,
      requestedChannel: null,
      storedChannel: null,
      channel: "stable",
      downgradeRisk: false,
      opts: { json: true, yes: true },
      preUpdatePluginInstallRecords: {},
      startedAt: Date.now(),
      updateStepTimeoutMs: 5_000,
      assertCurrent,
      beforeDoctor: async () => {
        await Promise.resolve();
        if (boundary === "maintenance-first-refusal") {
          refusalArmed = true;
        }
        if (boundary === "maintenance-replacement") {
          currentOwner = {};
        }
      },
    });
    if (boundary === "live") {
      expect((await outcome).resultWithPostUpdate.status).toBe("ok");
      expect(dispatched).toEqual(["repair", "validate", "readiness"]);
    } else {
      await expect(outcome).rejects.toBe(stale);
      // The terminal caller check is too late if the mutating child was dispatched.
      const allowed =
        boundary === "validation-replacement"
          ? ["repair", "validate"]
          : boundary === "doctor-revocation" || boundary === "config-read-revocation"
            ? ["repair"]
            : [];
      expect(dispatched).toEqual(allowed);
    }
  });
});
