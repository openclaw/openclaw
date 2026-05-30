import { describe, expect, it } from "vitest";
import { runDashboardSmokeSuite } from "../../scripts/dev/control-ui-dashboard-smoke-suite.ts";

describe("control-ui-dashboard-smoke-suite", () => {
  it("runs Projects, SNES Studio, and hardware proof with CI artifact directories", () => {
    const calls: Array<{ args: string[]; command: string; env: NodeJS.ProcessEnv }> = [];
    const summary = runDashboardSmokeSuite({
      artifactRoot: ".artifacts",
      profile: "ci",
      runner: (command, args, options) => {
        calls.push({ args, command, env: options.env });
        return { status: 0 };
      },
    });

    expect(summary.ok).toBe(true);
    expect(summary.artifactProfile).toBe("ci");
    expect(summary.artifactRoot).toBe(".artifacts");
    expect(summary.steps.map((step) => step.name)).toEqual([
      "Projects dashboard smoke",
      "SNES Studio dashboard smoke",
      "SNES Studio hardware proof bundle",
    ]);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      args: ["ui:smoke:projects"],
      command: "pnpm",
    });
    expect(calls[0]?.env.OPENCLAW_CONTROL_UI_PROJECTS_ARTIFACT_DIR).toBe(
      ".artifacts/control-ui-projects/ci",
    );
    expect(calls[1]).toMatchObject({
      args: ["ui:smoke:snes-studio"],
      command: "pnpm",
    });
    expect(calls[1]?.env.OPENCLAW_CONTROL_UI_SNES_STUDIO_ARTIFACT_DIR).toBe(
      ".artifacts/snes-studio-smoke/ci",
    );
    expect(calls[2]).toMatchObject({
      args: ["snes:hardware-proof", "--artifact-dir", ".artifacts/snes-hardware-proof/ci"],
      command: "pnpm",
    });
  });

  it("stops after the first failed smoke step", () => {
    const calls: string[] = [];
    const summary = runDashboardSmokeSuite({
      artifactRoot: ".artifacts",
      profile: "release",
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return { status: calls.length === 2 ? 1 : 0 };
      },
    });

    expect(summary.ok).toBe(false);
    expect(calls).toEqual(["pnpm ui:smoke:projects", "pnpm ui:smoke:snes-studio"]);
    expect(summary.steps).toEqual([
      {
        command: ["pnpm", "ui:smoke:projects"],
        exitCode: 0,
        name: "Projects dashboard smoke",
      },
      {
        command: ["pnpm", "ui:smoke:snes-studio"],
        exitCode: 1,
        name: "SNES Studio dashboard smoke",
      },
    ]);
  });

  it("previews release commands without executing them in dry-run mode", () => {
    const calls: string[] = [];
    const summary = runDashboardSmokeSuite({
      artifactRoot: ".artifacts",
      dryRun: true,
      profile: "release",
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return { status: 1 };
      },
    });

    expect(summary.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(summary.steps).toEqual([
      {
        command: ["pnpm", "ui:smoke:projects"],
        exitCode: 0,
        name: "Projects dashboard smoke",
      },
      {
        command: ["pnpm", "ui:smoke:snes-studio"],
        exitCode: 0,
        name: "SNES Studio dashboard smoke",
      },
      {
        command: [
          "pnpm",
          "snes:hardware-proof",
          "--artifact-dir",
          ".artifacts/snes-hardware-proof/release",
        ],
        exitCode: 0,
        name: "SNES Studio hardware proof bundle",
      },
    ]);
  });

  it("builds the Control UI first when local smoke lacks built assets", () => {
    const calls: string[] = [];
    const summary = runDashboardSmokeSuite({
      artifactRoot: ".artifacts/dashboard-smoke-suite/test-local",
      fileExists: () => false,
      profile: "local",
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return { status: 0 };
      },
    });

    expect(summary.ok).toBe(true);
    expect(calls[0]).toBe("pnpm ui:build");
    expect(calls).toContain("pnpm ui:smoke:projects");
  });
});
