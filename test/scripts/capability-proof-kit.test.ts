import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createBrowserProofBundle,
  createObservabilityReport,
  createProofEventBundle,
  createResearchCacheEntry,
  createSandboxProviderContract,
  createSecurityBouncerDecision,
  createWorkflowCanvas,
  scoreMarketplaceCapability,
} from "../../scripts/agents/capability-proof-kit.mjs";

describe("capability proof kit", () => {
  it("creates a proof-events bundle covering ticket, model, tool, browser, memory, and sidecar events", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-proof-events-bundle-"));
    try {
      const bundle = createProofEventBundle({
        events: [
          { component: "blackboard", eventType: "TICKET_TRANSITION", status: "PASS" },
          { component: "gateway", eventType: "MODEL_CALL", status: "PASS" },
          { component: "tool-runner", eventType: "TOOL_CALL", status: "PASS" },
          { component: "browser-ops", eventType: "BROWSER_ACTION", status: "PASS" },
          { component: "memory-wiki", eventType: "MEMORY_WRITE", status: "PASS" },
          { component: "signal-hub", eventType: "SIDECAR_HEALTH", status: "PASS" },
        ],
        outDir: dir,
        ticketId: "ticket-proof-events",
      });

      expect(bundle.kind).toBe("proof-events-bundle");
      expect(bundle.artifactContract).toMatchObject({
        kind: "proof-bundle",
        schemaVersion: "agent-os.artifact.v1",
        ticketId: "ticket-proof-events",
      });
      expect(bundle.missingRequiredEventTypes).toEqual([]);
      expect(bundle.coverage.byCategory).toMatchObject({
        browser: 1,
        memory: 1,
        model: 1,
        sidecar: 1,
        ticket: 1,
        tool: 1,
      });
      expect(existsSync(bundle.artifactPath)).toBe(true);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("creates browser proof bundles with session boundaries and artifacts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-browser-proof-"));
    try {
      const proof = createBrowserProofBundle({
        actions: [{ kind: "click", selector: "button[type=submit]", status: "PASS" }],
        assertions: ["visual assertion passed", "auth handoff preserved"],
        handoff: { mode: "operator-visible", required: true },
        outDir: dir,
        requests: [{ method: "GET", status: 200, url: "https://example.test" }],
        screenshotPath: "artifacts/browser.png",
        session: { isolation: "persistent-profile", owner: "local-operator" },
        snapshotPath: "artifacts/snapshot.json",
        ticketId: "ticket-browser",
        tracePath: "artifacts/trace.zip",
      });

      expect(proof.kind).toBe("browser-proof-bundle");
      expect(proof.accountBoundary).toMatchObject({ sessionPolicy: "no-secret-printing" });
      expect(proof.assertions).toContain("visual assertion passed");
      expect(proof.actions).toHaveLength(1);
      expect(proof.handoff).toMatchObject({ required: true });
      expect(proof.privacy.redactHeaders).toContain("authorization");
      expect(proof.session).toMatchObject({ owner: "local-operator" });
      expect(proof.trace).toMatchObject({ viewer: "playwright-trace-viewer-compatible" });
      expect(existsSync(proof.artifactPath)).toBe(true);
      expect(JSON.parse(readFileSync(proof.artifactPath, "utf8")).bundleId).toBe(proof.bundleId);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("creates research sidecar cache entries for SearXNG, archives, and citations", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-research-proof-"));
    try {
      const cache = createResearchCacheEntry({
        citations: ["Example Source, 2026"],
        connectors: [
          { id: "searxng", sourceType: "web" },
          { id: "obsidian", sourceType: "local" },
        ],
        datasets: [{ id: "agent-memory", provenance: "swarm-memory" }],
        outDir: dir,
        privateSourceBoundary: { allowedDestinations: ["local-cache"] },
        query: "best autonomous agent observability pattern",
        searxngBaseUrl: "http://searxng.local/search",
        sources: [
          {
            archiveUrl: "archive://example-source",
            citation: "Example Source, 2026",
            title: "Example Source",
            url: "https://example.test/source",
          },
        ],
        ticketId: "ticket-research",
      });

      expect(cache.searxng).toMatchObject({ mode: "configured" });
      expect(cache.archive.hitCount).toBe(1);
      expect(cache.citations).toEqual(["Example Source, 2026"]);
      expect(cache.connectors.map((connector) => connector.id)).toEqual(["searxng", "obsidian"]);
      expect(cache.datasets).toHaveLength(1);
      expect(cache.privateSourceBoundary).toMatchObject({ noPrivateSourceUpload: true });
      expect(cache.quoteBudget.maxQuotedWordsPerSource).toBe(25);
      expect(existsSync(cache.artifactPath)).toBe(true);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("creates security bouncer detect, decide, bounce, and repair proof", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-security-proof-"));
    try {
      const proof = createSecurityBouncerDecision({
        bounce: { action: "restart-sidecar", target: "signal-hub" },
        decision: { reason: "sidecar unhealthy", status: "PASS" },
        detection: { rule: "sidecar-health", severity: "high" },
        outDir: dir,
        policyGates: { repair: { defaultMode: "safe-local-repair" } },
        repair: { applied: true, command: "node scripts/docker/full-local.mjs up" },
        rollback: { command: "node scripts/docker/full-local.mjs down" },
        ticketId: "ticket-security",
      });

      expect(proof.kind).toBe("security-bouncer-decision");
      expect(proof.status).toBe("PASS");
      expect(proof.bounce).toMatchObject({ target: "signal-hub" });
      expect(proof.phases).toMatchObject({
        bounce: { status: "READY" },
        detect: { status: "PASS" },
        repair: { status: "PASS" },
        rollback: { status: "READY" },
      });
      expect(proof.policyGates.repair).toMatchObject({ defaultMode: "safe-local-repair" });
      expect(existsSync(proof.artifactPath)).toBe(true);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("builds workflow canvas and observability dashboard artifacts from proof events", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-canvas-proof-"));
    try {
      const proofEvents = [
        {
          component: "signal-hub",
          eventType: "SIGNAL_ROUTE",
          id: 1,
          status: "INFO",
          ticketId: "ticket-1",
        },
        {
          component: "security-bouncer",
          eventType: "BOUNCE_REPAIR",
          id: 2,
          status: "PASS",
          ticketId: "ticket-1",
        },
        {
          component: "browser-ops",
          eventType: "BROWSER_ASSERTION",
          id: 3,
          status: "FAIL",
          ticketId: "ticket-2",
        },
      ];
      const canvas = createWorkflowCanvas({
        agents: [{ id: "research_agent" }, { id: "security_bouncer_agent" }],
        approvals: [{ id: "repair-approval", status: "approved", ticketId: "ticket-1" }],
        outDir: dir,
        proofEvents,
        proofRequirements: ["browser-proof-bundle", "security-bouncer-decision"],
        replayPaths: [
          { command: "node scripts/docker/full-local.mjs smoke", ticketId: "ticket-1" },
        ],
        sidecars: [{ id: "signal-hub" }, { id: "security-bouncer" }],
        tickets: [{ id: "ticket-1", status: "DONE", type: "research" }],
      });
      const report = createObservabilityReport({
        costs: [0.01, 0.02],
        evals: [{ id: "smoke", score: 1 }],
        latencyMs: [100, 200, 900],
        outDir: dir,
        proofEvents,
        recovery: [{ action: "restart-sidecar" }],
        retries: [{ component: "browser-ops" }],
        ticketId: "proof-dashboard",
      });

      expect(canvas.nodes.some((node) => node.kind === "proof-event")).toBe(true);
      expect(canvas.edges).toContainEqual({
        from: "ticket:ticket-1",
        kind: "proved-by",
        to: "event:1",
      });
      expect(canvas.nodes.some((node) => node.kind === "approval")).toBe(true);
      expect(canvas.nodes.some((node) => node.kind === "replay-path")).toBe(true);
      expect(canvas.proofRequirements).toContain("browser-proof-bundle");
      expect(existsSync(canvas.htmlPath)).toBe(true);
      expect(report).toMatchObject({
        byStatus: { FAIL: 1, INFO: 1, PASS: 1 },
        ticketCount: 2,
        totalEvents: 3,
      });
      expect(report.metrics).toMatchObject({
        p95LatencyMs: 900,
        recoveryCount: 1,
        retryCount: 1,
        totalCostUsd: 0.03,
      });
      expect(existsSync(report.htmlPath)).toBe(true);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("creates sandbox provider contracts for future Python, Node, and containerized agents", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-sandbox-contract-"));
    try {
      const contract = createSandboxProviderContract({
        artifactExport: { paths: [".artifacts", "reports"] },
        id: "full-local-container",
        networkPolicy: { default: "deny-except-declared", allowedHosts: ["searxng"] },
        outDir: dir,
        proofCommand: "node scripts/agents/capability-proof-kit.mjs proof-events-bundle",
        runtime: {
          containerImage: "openclaw/full-local",
          node: "24",
          python: "3.12",
        },
        workspaceMounts: [
          {
            containerPath: "/workspace",
            hostPathPolicy: "operator-selected",
            mode: "read-write",
          },
        ],
      });

      expect(contract.kind).toBe("sandbox-provider-contract");
      expect(contract.status).toBe("ready");
      expect(contract.missing).toEqual([]);
      expect(contract.runtime).toMatchObject({ node: "24", python: "3.12" });
      expect(contract.workspaceMounts[0]).toMatchObject({
        containerPath: "/workspace",
        hostPathPolicy: "operator-selected",
      });
      expect(existsSync(contract.artifactPath)).toBe(true);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("scores marketplace compatibility metadata and flags unsafe gaps", () => {
    const ready = scoreMarketplaceCapability({
      manifest: {
        auth: { mode: "scoped" },
        id: "browser-ops",
        license: "MIT",
        os: ["linux", "macos", "windows"],
        permissions: ["network"],
        proofEvents: { required: ["MODEL_CALL", "TOOL_CALL"] },
        proofCommand: "node scripts/agents/capability-proof-kit.mjs browser-bundle",
        rollback: "disable capability",
        sandbox: "container",
        sandboxProvider: "ready",
        evals: { command: "node scripts/agents/capability-proof-kit.mjs observability-report" },
      },
    });
    expect(ready).toMatchObject({
      compatibilityScore: 100,
      compatibilitySignals: {
        evalCommand: true,
        proofEvents: true,
        sandboxProvider: true,
      },
      missing: [],
      riskClass: "ready",
    });

    const blocked = scoreMarketplaceCapability({
      manifest: {
        id: "unknown",
        license: "AGPL-3.0",
      },
    });
    expect(blocked.compatibilityScore).toBeLessThan(70);
    expect(blocked.licenseRisk).toBe("sidecar-required");
    expect(blocked.missing).toEqual(
      expect.arrayContaining(["proofCommand", "rollback", "scopedAuth", "sandbox"]),
    );
    expect(blocked.warnings).toEqual(
      expect.arrayContaining(["evalCommand", "proofEvents", "sandboxProvider"]),
    );
  });

  it("runs the marketplace-score CLI path without touching secrets", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-market-proof-"));
    try {
      const manifestPath = path.join(dir, "manifest.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          auth: { mode: "scoped" },
          id: "research-agent",
          license: "Apache-2.0",
          os: ["linux", "macos", "windows"],
          permissions: ["network"],
          proofCommand: "node scripts/agents/capability-proof-kit.mjs research-cache",
          rollback: "disable sidecar",
          sandbox: "container",
        }),
      );
      const score = scoreMarketplaceCapability({
        manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
      });

      expect(score.riskClass).toBe("ready");
      expect(score.compatibilityScore).toBe(100);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
