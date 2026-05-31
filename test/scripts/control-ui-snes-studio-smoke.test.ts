import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  assertMilestoneGates,
  createMilestoneGates,
  type MilestoneGate,
} from "../../scripts/dev/control-ui-snes-studio-smoke.js";

const externalProof = {
  emulators: {
    required: ["ares", "bsnes", "mesen", "snes9x"],
    detected: [],
    blocked: true,
    blocker: "No supported emulator executable was found on PATH or in /Applications.",
  },
  fxpak: {
    detectedVolumes: [],
    blocked: true,
    blocker: "No mounted FXPAK PRO or SD2SNES-style FAT32 volume was found under /Volumes.",
  },
  liveAgent: {
    ready: true,
    configured: false,
    e2eEnabled: false,
    blocked: false,
    blocker: null,
    note: "Live agents are ready; automated E2E was skipped because OPENCLAW_SNES_STUDIO_LIVE_AGENT_E2E is not set.",
  },
};

describe("control-ui-snes-studio-smoke milestone gates", () => {
  it("creates exactly ten sequential verified gates with concrete evidence", () => {
    const gates = createMilestoneGates({
      screenshots: [
        "desktop-make.png",
        "desktop-arrange.png",
        "desktop-ship.png",
        "mobile-play.png",
      ],
      downloads: ["game.sfc", "game.oc-snes.json", "game.oc-snes-bundle.json"],
      externalProof,
    });

    expect(gates.map((gate) => gate.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(gates.every((gate) => gate.status === "verified")).toBe(true);
    expect(gates.every((gate) => gate.evidence.length > 0)).toBe(true);
    expect(gates[2]?.evidence).toContain("Create screen checked for no hidden legacy cockpit.");
    expect(gates[2]?.evidence).toContain(
      "Create screen checked for no first-screen full professional workbench.",
    );
    expect(gates[7]?.evidence).toContain(externalProof.emulators.blocker);
    expect(gates[7]?.evidence).toContain(externalProof.liveAgent.note);
    expect(() => assertMilestoneGates(gates)).not.toThrow();
  });

  it("rejects missing or out-of-order milestone gate proof", () => {
    const gates = createMilestoneGates({
      screenshots: [
        "desktop-make.png",
        "desktop-arrange.png",
        "desktop-ship.png",
        "mobile-play.png",
      ],
      downloads: ["game.sfc", "game.oc-snes.json", "game.oc-snes-bundle.json"],
      externalProof,
    });
    const outOfOrder: MilestoneGate[] = [gates[1], gates[0], ...gates.slice(2)];
    const missingEvidence: MilestoneGate[] = gates.map((gate) =>
      gate.id === 5 ? { ...gate, evidence: [] } : gate,
    );

    expect(() => assertMilestoneGates(outOfOrder)).toThrow("milestone gates incomplete");
    expect(() => assertMilestoneGates(missingEvidence)).toThrow("milestone gates incomplete");
    expect(() => assertMilestoneGates(gates.slice(0, 9))).toThrow("milestone gates incomplete");
  });

  it("keeps CI and release dashboard artifact chains wired to hardware proof bundles", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["ui:smoke:dashboard"]).toBe(
      "node --import tsx scripts/dev/control-ui-dashboard-smoke-suite.ts",
    );

    const workflows = [
      {
        path: ".github/workflows/ci.yml",
        jobName: "dashboard-smoke",
        suiteCommand: "pnpm ui:smoke:dashboard -- --artifact-profile ci",
        artifactName: "control-ui-snes-studio-hardware-proof-",
        requiredNeeds: ["preflight", "build-artifacts"],
        expectedRunner: "ubuntu-24.04",
        buildStep: null,
        downloadArtifact: true,
      },
      {
        path: ".github/workflows/openclaw-release-checks.yml",
        jobName: "dashboard_smoke_release_checks",
        suiteCommand: "pnpm ui:smoke:dashboard -- --artifact-profile release",
        artifactName: "release-control-ui-snes-studio-hardware-proof-",
        requiredNeeds: ["resolve_target"],
        expectedRunner: "blacksmith-8vcpu-ubuntu-2404",
        buildStep: ["pnpm ui:build", "pnpm build"],
        downloadArtifact: false,
      },
    ];

    for (const workflow of workflows) {
      const document = parse(readFileSync(workflow.path, "utf8")) as {
        jobs?: Record<
          string,
          {
            needs?: string[];
            "runs-on"?: string;
            steps?: Array<Record<string, unknown>>;
          }
        >;
      };
      const job = document.jobs?.[workflow.jobName];
      expect(job).toBeTruthy();
      expect(job?.needs).toEqual(workflow.requiredNeeds);
      expect(job?.["runs-on"]).toBe(workflow.expectedRunner);
      const steps = job?.steps ?? [];

      if (workflow.downloadArtifact) {
        expect(steps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "Download built runtime artifacts",
              uses: "actions/download-artifact@v8",
              with: expect.objectContaining({
                name: "dist-runtime-build",
                path: ".",
              }),
            }),
            expect.objectContaining({
              name: "Extract built runtime artifacts",
            }),
          ]),
        );
      }
      if (workflow.buildStep) {
        expect(steps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "Build dashboard runtime",
              run: expect.stringContaining(workflow.buildStep[0]),
            }),
          ]),
        );
        expect(steps.find((step) => step.name === "Build dashboard runtime")?.run).toEqual(
          expect.stringContaining(workflow.buildStep[1]),
        );
      }

      expect(steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Install Playwright Chromium",
            run: "pnpm exec playwright install --with-deps chromium",
          }),
          expect.objectContaining({
            name: "Run dashboard smoke suite",
            run: workflow.suiteCommand,
          }),
        ]),
      );
      expect(steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Upload SNES Studio hardware proof artifacts",
            with: expect.objectContaining({
              name: expect.stringContaining(workflow.artifactName),
              path: ".artifacts/snes-hardware-proof/",
            }),
          }),
        ]),
      );
    }
  });

  it("keeps Full Release Validation dashboard reruns routed into release checks", () => {
    const document = parse(
      readFileSync(".github/workflows/full-release-validation.yml", "utf8"),
    ) as {
      on?: {
        workflow_dispatch?: {
          inputs?: {
            rerun_group?: {
              options?: string[];
            };
          };
        };
      };
      jobs?: Record<
        string,
        {
          if?: string;
          needs?: string[];
        }
      >;
    };

    expect(document.on?.workflow_dispatch?.inputs?.rerun_group?.options).toContain("dashboard");
    expect(document.jobs?.release_checks?.needs).toEqual([
      "resolve_target",
      "docker_runtime_assets_preflight",
    ]);
    expect(document.jobs?.release_checks?.if).toContain('"dashboard"');
    expect(document.jobs?.release_checks?.if).toContain("inputs.rerun_group");
  });
});
