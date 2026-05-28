import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectCardFrameworkReport,
  runCardFrameworkCheck,
} from "../../scripts/check-openclaw-card-framework.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const ARCHITECTURE_WORLD_MODEL_STUDY_PATH =
  "reports/openclaw-architecture-world-model-open-source-study.md";
const FAST_SIMULATION_ITERATIONS = 1;
const SCENARIO_COVERAGE_ITERATIONS = 64;

async function writeFile(rootDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function collectFastCardFrameworkReport(rootDir: string) {
  return collectCardFrameworkReport({
    repoRoot: rootDir,
    simulationIterations: FAST_SIMULATION_ITERATIONS,
  });
}

function createCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "source-card",
    type: "source",
    title: "Source card",
    summary: "Source evidence.",
    sourceUrls: ["docs/source.md"],
    openclawTarget: "docs",
    inputs: ["input"],
    outputs: ["output"],
    contract: "contract",
    risk: ["risk"],
    validation: ["check"],
    rollbackPath: "rollback",
    nextSafeTask: "next",
    linksTo: ["capability-card", "validation-card"],
    humanReadableCheck: "Readable check.",
    ...overrides,
  };
}

function createComponentCard(overrides: Record<string, unknown>): Record<string, unknown> {
  const componentRole = String(overrides.componentRole);
  return createCard({
    type: "component",
    title: `${componentRole} component`,
    summary: `${componentRole} original architecture component.`,
    sourceUrls: ["docs/inventory.md"],
    openclawTarget: "runtime",
    inputs: ["upstream"],
    outputs: ["downstream"],
    contract: `${componentRole} component contract`,
    validation: ["pnpm autonomous:inventory:check"],
    rollbackPath: `rollback ${componentRole}`,
    nextSafeTask: `check ${componentRole}`,
    humanReadableCheck: `${componentRole} readable.`,
    ...overrides,
  });
}

function createComponentCards(): Record<string, unknown>[] {
  return [
    createComponentCard({
      id: "component-gateway",
      componentRole: "gateway",
      componentPaths: ["src/gateway"],
      linksTo: ["component-channel", "component-plugin-loader", "contract-card"],
    }),
    createComponentCard({
      id: "component-channel",
      componentRole: "channel",
      componentPaths: ["src/channels"],
      openclawTarget: "plugin",
      linksTo: ["component-gateway", "component-plugin-loader", "validation-card"],
    }),
    createComponentCard({
      id: "component-plugin-loader",
      componentRole: "plugin-loader",
      componentPaths: ["src/plugins"],
      openclawTarget: "plugin",
      sourceUrls: ["docs/plugin.md"],
      linksTo: ["component-plugin-sdk", "component-extension", "validation-card"],
    }),
    createComponentCard({
      id: "component-plugin-sdk",
      componentRole: "plugin-sdk",
      componentPaths: ["src/plugin-sdk"],
      linksTo: ["component-plugin-loader", "component-extension", "contract-card"],
    }),
    createComponentCard({
      id: "component-extension",
      componentRole: "extension",
      componentPaths: ["extensions"],
      openclawTarget: "plugin",
      linksTo: ["component-plugin-loader", "component-plugin-sdk", "validation-card"],
    }),
    createComponentCard({
      id: "component-skill",
      componentRole: "skill",
      componentPaths: ["skills"],
      openclawTarget: "skill",
      sourceUrls: ["docs/source.md"],
      linksTo: ["component-controlled-runner", "validation-card", "report-card"],
    }),
    createComponentCard({
      id: "component-controlled-runner",
      componentRole: "controlled-runner",
      componentPaths: ["scripts/openclaw-controlled-task-runner.mjs"],
      linksTo: ["component-taskflow", "component-validation-gate", "component-report-state"],
    }),
    createComponentCard({
      id: "component-taskflow",
      componentRole: "taskflow",
      componentPaths: ["docs/automation/taskflow.md"],
      openclawTarget: "taskflow",
      sourceUrls: ["docs/taskflow.md"],
      linksTo: [
        "component-controlled-runner",
        "component-scheduler-hooks",
        "component-report-state",
      ],
    }),
    createComponentCard({
      id: "component-scheduler-hooks",
      componentRole: "scheduler-hooks",
      componentPaths: ["src/cron", "src/hooks"],
      linksTo: ["component-controlled-runner", "component-taskflow", "component-validation-gate"],
    }),
    createComponentCard({
      id: "component-memory",
      componentRole: "memory",
      componentPaths: ["src/memory"],
      linksTo: ["component-report-state", "component-validation-gate", "contract-card"],
    }),
    createComponentCard({
      id: "component-ui-surface",
      componentRole: "ui-surface",
      componentPaths: ["ui"],
      openclawTarget: "plugin",
      linksTo: ["component-gateway", "component-report-state", "validation-card"],
    }),
    createComponentCard({
      id: "component-config",
      componentRole: "config",
      componentPaths: ["config"],
      linksTo: ["component-gateway", "component-validation-gate", "contract-card"],
    }),
    createComponentCard({
      id: "component-validation-gate",
      componentRole: "validation-gate",
      componentPaths: ["scripts/check-openclaw-card-framework.mjs"],
      linksTo: ["validation-card", "component-report-state", "component-controlled-runner"],
    }),
    createComponentCard({
      id: "component-report-state",
      componentRole: "report-state",
      componentPaths: ["reports"],
      openclawTarget: "docs",
      linksTo: ["report-card", "component-validation-gate", "component-memory"],
    }),
    createComponentCard({
      id: "component-trading-runtime",
      componentRole: "trading-runtime",
      componentPaths: ["scripts/openclaw-capital-paper-automation-loop.mjs"],
      validation: ["pnpm brokerdesk:auto-trading-loop:check"],
      risk: ["live trading must stay blocked"],
      linksTo: [
        "component-trading-risk-gate",
        "component-validation-gate",
        "component-report-state",
      ],
    }),
    createComponentCard({
      id: "component-trading-risk-gate",
      componentRole: "trading-risk-gate",
      componentPaths: ["scripts/check-capital-paper-automation-loop.mjs"],
      validation: ["pnpm brokerdesk:capital:simulation:1000:check"],
      risk: ["paper-only gate could be bypassed"],
      linksTo: ["component-validation-gate", "component-report-state", "component-trading-runtime"],
    }),
  ];
}

function createPassingRegistry(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    framework: "openclaw-card-framework",
    cards: [
      createCard(),
      createCard({
        id: "capability-card",
        type: "capability",
        sourceUrls: ["docs/source.md"],
        openclawTarget: "skill",
        linksTo: ["module-plugin-card", "contract-card", "validation-card"],
      }),
      createCard({
        id: "module-plugin-card",
        type: "module",
        sourceUrls: ["docs/plugin.md"],
        openclawTarget: "plugin",
        linksTo: ["contract-card", "validation-card"],
      }),
      createCard({
        id: "module-taskflow-card",
        type: "module",
        sourceUrls: ["docs/taskflow.md"],
        openclawTarget: "taskflow",
        linksTo: ["contract-card", "report-card"],
      }),
      createCard({
        id: "contract-card",
        type: "contract",
        sourceUrls: ["docs/inventory.md"],
        openclawTarget: "runtime",
        linksTo: ["validation-card", "report-card"],
      }),
      createCard({
        id: "validation-card",
        type: "validation",
        sourceUrls: ["scripts/check.mjs"],
        openclawTarget: "runtime",
        linksTo: ["report-card", "source-card"],
      }),
      createCard({
        id: "report-card",
        type: "report",
        sourceUrls: ["reports/report.md"],
        openclawTarget: "docs",
        linksTo: ["source-card", "validation-card"],
      }),
      createCard({
        id: "source-architecture-as-code-standards",
        type: "source",
        title: "Architecture-as-code source card",
        sourceUrls: [
          "https://arc42.org/",
          "https://c4model.com/",
          "https://docs.structurizr.com/as-code",
          ARCHITECTURE_WORLD_MODEL_STUDY_PATH,
        ],
        openclawTarget: "docs",
        linksTo: [
          "module-architecture-model-as-code",
          "contract-architecture-world-model-drift-gate",
          "validation-card",
        ],
      }),
      createCard({
        id: "module-architecture-model-as-code",
        type: "module",
        title: "Architecture model as code",
        sourceUrls: ["https://docs.structurizr.com/as-code", ARCHITECTURE_WORLD_MODEL_STUDY_PATH],
        openclawTarget: "runtime",
        linksTo: [
          "component-validation-gate",
          "component-report-state",
          "contract-architecture-world-model-drift-gate",
          "validation-card",
        ],
      }),
      createCard({
        id: "source-world-model-simulation-standards",
        type: "source",
        title: "World model source card",
        sourceUrls: [
          "https://worldmodels.github.io/",
          "https://github.com/danijar/dreamerv3",
          ARCHITECTURE_WORLD_MODEL_STUDY_PATH,
        ],
        openclawTarget: "docs",
        linksTo: [
          "module-world-model-simulation-gate",
          "contract-architecture-world-model-drift-gate",
          "component-memory",
          "validation-card",
        ],
      }),
      createCard({
        id: "module-world-model-simulation-gate",
        type: "module",
        title: "World model simulation gate",
        sourceUrls: [
          "https://worldmodels.github.io/",
          ARCHITECTURE_WORLD_MODEL_STUDY_PATH,
          "reports/openclaw-card-framework-simulation-latest.md",
        ],
        openclawTarget: "runtime",
        linksTo: [
          "component-validation-gate",
          "component-report-state",
          "component-trading-risk-gate",
          "component-memory",
          "validation-card",
        ],
      }),
      createCard({
        id: "contract-architecture-world-model-drift-gate",
        type: "contract",
        title: "Architecture world model drift gate",
        sourceUrls: [
          "https://docs.structurizr.com/as-code",
          "https://worldmodels.github.io/",
          ARCHITECTURE_WORLD_MODEL_STUDY_PATH,
        ],
        openclawTarget: "runtime",
        linksTo: ["validation-card", "report-card", "component-trading-risk-gate"],
      }),
      createCard({
        id: "source-3d-viewpoint-node-graph-standards",
        type: "source",
        title: "3D viewpoint node graph source",
        sourceUrls: [
          "https://threejs.org/docs/#manual/en/introduction/Creating-a-scene",
          "https://threejs.org/docs/api/en/core/Raycaster.html",
          "https://github.com/vasturiano/3d-force-graph",
          ARCHITECTURE_WORLD_MODEL_STUDY_PATH,
        ],
        openclawTarget: "docs",
        linksTo: [
          "module-3d-viewpoint-node-model",
          "contract-3d-viewpoint-node-graph-gate",
          "module-architecture-model-as-code",
          "validation-card",
        ],
      }),
      createCard({
        id: "module-3d-viewpoint-node-model",
        type: "module",
        title: "3D viewpoint node model",
        sourceUrls: [
          "https://github.com/vasturiano/3d-force-graph",
          "https://github.com/lagodiuk/3D-knowledge-graph",
          ARCHITECTURE_WORLD_MODEL_STUDY_PATH,
          "reports/openclaw-card-framework-simulation-latest.md",
        ],
        openclawTarget: "runtime",
        linksTo: [
          "component-ui-surface",
          "component-validation-gate",
          "component-report-state",
          "module-architecture-model-as-code",
          "module-world-model-simulation-gate",
          "contract-3d-viewpoint-node-graph-gate",
          "validation-card",
        ],
      }),
      createCard({
        id: "contract-3d-viewpoint-node-graph-gate",
        type: "contract",
        title: "3D viewpoint node graph gate",
        sourceUrls: [
          "https://threejs.org/docs/api/en/core/Raycaster.html",
          "https://github.com/vasturiano/3d-force-graph",
          ARCHITECTURE_WORLD_MODEL_STUDY_PATH,
        ],
        openclawTarget: "runtime",
        linksTo: [
          "validation-card",
          "report-card",
          "component-ui-surface",
          "component-trading-risk-gate",
        ],
      }),
      ...createComponentCards(),
    ],
  };
}

async function writePassingFixture(rootDir: string): Promise<void> {
  for (const relativePath of [
    "docs/source.md",
    "docs/plugin.md",
    "docs/taskflow.md",
    "docs/inventory.md",
    "docs/automation/autonomous-runtime.md",
    "docs/automation/module-skill-inventory.md",
    "docs/automation/taskflow.md",
    "docs/tools/plugin.md",
    "docs/tools/skills.md",
    "scripts/check.mjs",
    "scripts/check-openclaw-card-framework.mjs",
    "skills/openclaw-card-framework-builder/SKILL.md",
    ARCHITECTURE_WORLD_MODEL_STUDY_PATH,
    "reports/openclaw-card-framework-simulation-latest.md",
    "reports/report.md",
  ]) {
    await writeFile(
      rootDir,
      relativePath,
      relativePath === "skills/openclaw-card-framework-builder/SKILL.md"
        ? [
            "---",
            "name: openclaw-card-framework-builder",
            "description: Build OpenClaw modules through linked cards.",
            "---",
            "Source Card",
            "Component Card",
            "Capability Card",
            "Module Card",
            "Contract Card",
            "Validation Card",
            "Report Card",
            "pnpm check:openclaw-card-framework",
            "BLOCKED_CARD_FRAMEWORK",
            "falseAccepted=0",
            "falseBlocked=0",
            "docs skill plugin runtime taskflow",
            "componentRole",
            "componentPaths",
            "trading-risk-gate",
            "Architecture Card",
            "World Model Card",
            "3D Viewpoint Card",
            "3D Node Graph Card",
            "architecture-as-code",
            "world-model simulation",
            "3D viewpoint",
            "2D fallback",
            "drift detection",
            "",
          ].join("\n")
        : "ok\n",
    );
  }
  for (const relativePath of [
    "src/gateway",
    "src/channels",
    "src/plugins",
    "src/plugin-sdk",
    "extensions",
    "skills",
    "src/cron",
    "src/hooks",
    "src/memory",
    "ui",
    "config",
    "reports",
  ]) {
    await fs.mkdir(path.join(rootDir, relativePath), { recursive: true });
  }
  for (const relativePath of [
    "scripts/openclaw-controlled-task-runner.mjs",
    "scripts/openclaw-capital-paper-automation-loop.mjs",
    "scripts/check-capital-paper-automation-loop.mjs",
  ]) {
    await writeFile(
      rootDir,
      relativePath,
      relativePath === "scripts/openclaw-controlled-task-runner.mjs"
        ? [
            "collectCardFrameworkReport",
            "runCardFrameworkPreflight",
            "card_framework_preflight",
            "BLOCKED_CARD_FRAMEWORK",
            "simulationIterations: 1000",
            "buildCardFrameworkBlockedCommandResult",
            "",
          ].join("\n")
        : "ok\n",
    );
  }
  await writeFile(
    rootDir,
    "reports/openclaw-card-framework-cards.json",
    `${JSON.stringify(createPassingRegistry(), null, 2)}\n`,
  );
}

describe("check-openclaw-card-framework", () => {
  it("passes complete card registry with linked OpenClaw targets", async () => {
    const rootDir = createTempDir("openclaw-card-framework-pass-");
    await writePassingFixture(rootDir);

    const report = await collectCardFrameworkReport({ repoRoot: rootDir });

    expect(report.summary.ok).toBe(true);
    expect(report.summary.simulation.correct).toBe(1000);
    expect(report.summary.simulation.falseAccepted).toBe(0);
    expect(report.summary.simulation.falseBlocked).toBe(0);
    expect(report.summary.architectureImpact).toMatchObject({
      ok: true,
      protectedComponents: 16,
      requiredComponents: 16,
      runnerPreflightEnforced: true,
      tradingRuntimeLinkedToRiskGate: true,
      tradingRiskGateLinkedToValidationAndReport: true,
    });
    expect(report.summary.simulation.acceptedCorrect).toBeGreaterThan(0);
    expect(report.summary.simulation.blockedIncorrect).toBeGreaterThan(0);
    expect(report.coverage.byTarget).toMatchObject({
      docs: 6,
      plugin: 5,
      runtime: 16,
      skill: 2,
      taskflow: 2,
    });
    expect(report.coverage.byType).toMatchObject({
      component: 16,
    });
    expect(report.coverage.byComponentRole).toMatchObject({
      gateway: 1,
      "trading-runtime": 1,
      "trading-risk-gate": 1,
    });
  });

  it("separates valid simulation cases from invalid cases with the production validator", async () => {
    const rootDir = createTempDir("openclaw-card-framework-simulation-separation-");
    await writePassingFixture(rootDir);

    const report = await collectCardFrameworkReport({
      repoRoot: rootDir,
      simulationIterations: SCENARIO_COVERAGE_ITERATIONS,
    });

    expect(report.summary.simulation.byCase["valid-linked-registry"]).toMatchObject({
      decision: "accept",
      expected: "accept",
    });
    expect(report.summary.simulation.byCase["missing-source-evidence"]).toMatchObject({
      decision: "block",
      expected: "block",
    });
    expect(report.summary.simulation.byCase["standalone-helper-only"]).toMatchObject({
      decision: "block",
      expected: "block",
    });
    expect(report.summary.simulation.byCase["unsafe-real-api-write"]).toMatchObject({
      decision: "block",
      expected: "block",
    });
    expect(
      report.summary.simulation.byCase["missing-architecture-world-model-study-source"],
    ).toMatchObject({
      decision: "block",
      expected: "block",
    });
    expect(report.summary.simulation.byCase["missing-3d-viewpoint-node-model"]).toMatchObject({
      decision: "block",
      expected: "block",
    });
    expect(report.summary.simulation.byCase["original-component-graph-valid"]).toMatchObject({
      decision: "accept",
      expected: "accept",
    });
    expect(
      report.summary.simulation.byCase["trading-runtime-without-risk-gate-link"],
    ).toMatchObject({
      decision: "block",
      expected: "block",
    });
    expect(
      report.summary.architectureImpact.guardedBreakCaseStatus[
        "trading-runtime-without-risk-gate-link"
      ],
    ).toBe(true);
    expect(
      report.summary.architectureImpact.guardedBreakCaseStatus["missing-3d-viewpoint-node-model"],
    ).toBe(true);
  });

  it("fails when a card has no multi-card links", async () => {
    const rootDir = createTempDir("openclaw-card-framework-link-fail-");
    await writePassingFixture(rootDir);
    const registry = createPassingRegistry();
    (registry.cards as Record<string, unknown>[])[0].linksTo = [];
    await writeFile(
      rootDir,
      "reports/openclaw-card-framework-cards.json",
      `${JSON.stringify(registry, null, 2)}\n`,
    );

    const report = await collectFastCardFrameworkReport(rootDir);

    expect(report.summary.ok).toBe(false);
    expect(report.checks.some((check) => check.id === "card:source-card:linksTo")).toBe(true);
  });

  it("fails when source evidence cannot be resolved", async () => {
    const rootDir = createTempDir("openclaw-card-framework-source-fail-");
    await writePassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "docs/source.md"));

    const report = await collectFastCardFrameworkReport(rootDir);

    expect(report.summary.ok).toBe(false);
    expect(report.checks.some((check) => check.id.includes("source:docs/source.md"))).toBe(true);
  });

  it("fails when required OpenClaw target coverage is missing", async () => {
    const rootDir = createTempDir("openclaw-card-framework-target-fail-");
    await writePassingFixture(rootDir);
    const registry = createPassingRegistry();
    registry.cards = (registry.cards as Record<string, unknown>[]).filter(
      (card) => card.openclawTarget !== "taskflow",
    );
    await writeFile(
      rootDir,
      "reports/openclaw-card-framework-cards.json",
      `${JSON.stringify(registry, null, 2)}\n`,
    );

    const report = await collectFastCardFrameworkReport(rootDir);

    expect(report.summary.ok).toBe(false);
    expect(report.checks.some((check) => check.id === "coverage:target:taskflow")).toBe(true);
  });

  it("fails when architecture/world-model required cards are missing", async () => {
    const rootDir = createTempDir("openclaw-card-framework-required-model-card-fail-");
    await writePassingFixture(rootDir);
    const registry = createPassingRegistry();
    registry.cards = (registry.cards as Record<string, unknown>[]).filter(
      (card) => card.id !== "module-world-model-simulation-gate",
    );
    await writeFile(
      rootDir,
      "reports/openclaw-card-framework-cards.json",
      `${JSON.stringify(registry, null, 2)}\n`,
    );

    const report = await collectFastCardFrameworkReport(rootDir);

    expect(report.summary.ok).toBe(false);
    expect(
      report.checks.some(
        (check) => check.id === "coverage:card:module-world-model-simulation-gate",
      ),
    ).toBe(true);
  });

  it("fails when 3D viewpoint required cards are missing", async () => {
    const rootDir = createTempDir("openclaw-card-framework-3d-card-fail-");
    await writePassingFixture(rootDir);
    const registry = createPassingRegistry();
    registry.cards = (registry.cards as Record<string, unknown>[]).filter(
      (card) => card.id !== "module-3d-viewpoint-node-model",
    );
    await writeFile(
      rootDir,
      "reports/openclaw-card-framework-cards.json",
      `${JSON.stringify(registry, null, 2)}\n`,
    );

    const report = await collectFastCardFrameworkReport(rootDir);

    expect(report.summary.ok).toBe(false);
    expect(
      report.checks.some((check) => check.id === "coverage:card:module-3d-viewpoint-node-model"),
    ).toBe(true);
  });

  it("fails when architecture/world-model required cards do not link the open-source study", async () => {
    const rootDir = createTempDir("openclaw-card-framework-study-source-fail-");
    await writePassingFixture(rootDir);
    const registry = createPassingRegistry();
    const card = (registry.cards as Record<string, unknown>[]).find(
      (entry) => entry.id === "module-world-model-simulation-gate",
    );
    card!.sourceUrls = (card!.sourceUrls as string[]).filter(
      (sourceUrl) => sourceUrl !== ARCHITECTURE_WORLD_MODEL_STUDY_PATH,
    );
    await writeFile(
      rootDir,
      "reports/openclaw-card-framework-cards.json",
      `${JSON.stringify(registry, null, 2)}\n`,
    );

    const report = await collectFastCardFrameworkReport(rootDir);

    expect(report.summary.ok).toBe(false);
    expect(
      report.checks.some(
        (check) =>
          check.id === "coverage:architecture-world-model-study:module-world-model-simulation-gate",
      ),
    ).toBe(true);
  });

  it("fails when an original architecture component role is missing", async () => {
    const rootDir = createTempDir("openclaw-card-framework-component-role-fail-");
    await writePassingFixture(rootDir);
    const registry = createPassingRegistry();
    registry.cards = (registry.cards as Record<string, unknown>[]).filter(
      (card) => card.componentRole !== "gateway",
    );
    await writeFile(
      rootDir,
      "reports/openclaw-card-framework-cards.json",
      `${JSON.stringify(registry, null, 2)}\n`,
    );

    const report = await collectFastCardFrameworkReport(rootDir);

    expect(report.summary.ok).toBe(false);
    expect(report.checks.some((check) => check.id === "coverage:component-role:gateway")).toBe(
      true,
    );
  });

  it("fails when an original architecture component path is missing", async () => {
    const rootDir = createTempDir("openclaw-card-framework-component-path-fail-");
    await writePassingFixture(rootDir);
    const registry = createPassingRegistry();
    const gatewayCard = (registry.cards as Record<string, unknown>[]).find(
      (card) => card.componentRole === "gateway",
    );
    gatewayCard!.componentPaths = ["src/missing-gateway"];
    await writeFile(
      rootDir,
      "reports/openclaw-card-framework-cards.json",
      `${JSON.stringify(registry, null, 2)}\n`,
    );

    const report = await collectFastCardFrameworkReport(rootDir);

    expect(report.summary.ok).toBe(false);
    expect(
      report.checks.some(
        (check) => check.id === "card:component-gateway:componentPath:src/missing-gateway",
      ),
    ).toBe(true);
  });

  it("fails when trading runtime is not linked to the trading risk gate", async () => {
    const rootDir = createTempDir("openclaw-card-framework-trading-link-fail-");
    await writePassingFixture(rootDir);
    const registry = createPassingRegistry();
    const tradingCard = (registry.cards as Record<string, unknown>[]).find(
      (card) => card.componentRole === "trading-runtime",
    );
    tradingCard!.linksTo = ["component-validation-gate", "component-report-state"];
    await writeFile(
      rootDir,
      "reports/openclaw-card-framework-cards.json",
      `${JSON.stringify(registry, null, 2)}\n`,
    );

    const report = await collectFastCardFrameworkReport(rootDir);

    expect(report.summary.ok).toBe(false);
    expect(
      report.checks.some(
        (check) => check.id === "component-link:trading-runtime->trading-risk-gate",
      ),
    ).toBe(true);
  });

  it("fails when the controlled runner does not enforce card framework preflight", async () => {
    const rootDir = createTempDir("openclaw-card-framework-runner-preflight-fail-");
    await writePassingFixture(rootDir);
    await writeFile(
      rootDir,
      "scripts/openclaw-controlled-task-runner.mjs",
      "card_framework_preflight\nBLOCKED_CARD_FRAMEWORK\n",
    );

    const report = await collectFastCardFrameworkReport(rootDir);

    expect(report.summary.ok).toBe(false);
    expect(report.summary.architectureImpact.runnerPreflightEnforced).toBe(false);
    expect(
      report.checks.some(
        (check) => check.id === "runner-preflight:term:collectCardFrameworkReport",
      ),
    ).toBe(true);
  });

  it("fails when the builder skill is missing future-production terms", async () => {
    const rootDir = createTempDir("openclaw-card-framework-builder-skill-fail-");
    await writePassingFixture(rootDir);
    await writeFile(
      rootDir,
      "skills/openclaw-card-framework-builder/SKILL.md",
      "---\nname: openclaw-card-framework-builder\ndescription: incomplete\n---\n",
    );

    const report = await collectFastCardFrameworkReport(rootDir);

    expect(report.summary.ok).toBe(false);
    expect(report.checks.some((check) => check.id === "builder-skill:term:Source Card")).toBe(true);
  });

  it("returns non-zero in --check mode for invalid registry and reports readable failure", async () => {
    const rootDir = createTempDir("openclaw-card-framework-runner-fail-");
    await writeFile(rootDir, "reports/openclaw-card-framework-cards.json", '{"cards": []}\n');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCardFrameworkCheck({
      argv: ["--check"],
      repoRoot: rootDir,
      simulationIterations: FAST_SIMULATION_ITERATIONS,
      io: {
        stdout: { write: (text: string) => stdout.push(text) },
        stderr: { write: (text: string) => stderr.push(text) },
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout.join("")).toContain("OpenClaw 卡片式框架查驗");
    expect(stderr.join("")).toContain("openclaw card framework check failed");
  });
});
