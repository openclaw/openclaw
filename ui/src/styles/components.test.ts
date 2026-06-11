import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readCss(path: string): string {
  const cssPath = [resolve(process.cwd(), path), resolve(process.cwd(), "..", path)].find(
    (candidate) => existsSync(candidate),
  );
  expect(cssPath).toBeTruthy();
  return readFileSync(cssPath!, "utf8");
}

function readComponentsCss(): string {
  return readCss("ui/src/styles/components.css");
}

function readAgentsCss(): string {
  return readCss("ui/src/styles/agents.css");
}

function readKalshiDashboardCss(): string {
  return readCss("ui/src/styles/kalshi-dashboard.css");
}

function readProjectsCss(): string {
  return readCss("ui/src/styles/projects.css");
}

describe("mission-control visual system", () => {
  it("keeps the default dashboard theme on the aerospace control-room palette", () => {
    const baseCss = readCss("ui/src/styles/base.css");
    const layoutCss = readCss("ui/src/styles/layout.css");
    const componentsCss = readComponentsCss();
    const agentsCss = readAgentsCss();

    expect(baseCss).toContain("--bg: #02050a;");
    expect(baseCss).toContain("--accent-2: #7de3ff;");
    expect(baseCss).toContain("--mission-grid-line:");
    expect(baseCss).toContain("--mission-redline:");
    expect(baseCss).toContain("--mission-panel-line:");
    expect(baseCss).toContain("--mission-shadow-hard:");
    expect(baseCss).toContain("letter-spacing: 0;");
    expect(layoutCss).toContain('content: "MISSION CONTROL";');
    expect(layoutCss).toContain(".content-header::before");
    expect(layoutCss).toContain(".topbar::after");
    expect(layoutCss).toContain("linear-gradient(90deg, var(--mission-redline), var(--accent-2)");
    expect(componentsCss).toContain("Buttons - Mission-control controls");
    expect(componentsCss).toContain(".card::before");
    expect(componentsCss).toContain("SpaceX-inspired dashboard polish");
    expect(agentsCss).toContain(".agent-room-stage");
    expect(agentsCss).toContain(".agent-room-worker--working .agent-room-worker__status");
    expect(componentsCss).toContain(
      "linear-gradient(90deg, var(--mission-redline), var(--accent-2)",
    );
  });

  it("keeps heavy route styles split out of the startup stylesheet", () => {
    const componentsCss = readComponentsCss();
    const agentsCss = readAgentsCss();
    const kalshiCss = readKalshiDashboardCss();
    const projectsCss = readProjectsCss();

    expect(componentsCss).not.toContain("Kalshi Dashboard");
    expect(componentsCss).not.toContain(".kalshi-page");
    expect(componentsCss).not.toContain("Agents\n   ===========================================");
    expect(componentsCss).not.toContain(".agents-layout");
    expect(componentsCss).not.toContain(".projects-view");
    expect(agentsCss).toContain("Agents\n   ===========================================");
    expect(agentsCss).toContain(".agent-room-project");
    expect(kalshiCss).toContain("Kalshi Dashboard");
    expect(kalshiCss).toContain(".kalshi-page");
    expect(projectsCss).toContain(".projects-view");
  });
});

describe("mobile dashboard hardening styles", () => {
  it("keeps the Kalshi dashboard inside portrait phone bounds", () => {
    const css = readKalshiDashboardCss();

    expect(css).toContain(".kalshi-page,\n.kalshi-page * {\n  box-sizing: border-box;");
    expect(css).toContain("max-width: 100%;");
    expect(css).toContain("-webkit-overflow-scrolling: touch;");
    expect(css).toContain("@media (max-width: 620px)");
    expect(css).toContain(".kalshi-table-scroll table {\n    min-width: 640px;");
  });
});

describe("agent fallback chip styles", () => {
  it("styles the chip remove control inside the agent model input", () => {
    const css = readAgentsCss();

    expect(css).toContain(".agent-chip-input .chip {");
    expect(css).toContain(".agent-chip-input .chip-remove {");
    expect(css).toContain(".agent-chip-input .chip-remove:hover:not(:disabled)");
    expect(css).toContain(".agent-chip-input .chip-remove:focus-visible:not(:disabled)");
    expect(css).toContain("outline: 2px solid var(--accent);");
    expect(css).toContain("outline-offset: 2px;");
    expect(css).toContain(".agent-chip-input .chip-remove:disabled");
  });
});

describe("sessions filter styles", () => {
  it("keeps the expanded sessions filters on one row until the mobile breakpoint", () => {
    const css = readComponentsCss();

    expect(css).toContain(".sessions-filter-bar {\n  display: flex;\n  flex-wrap: wrap;");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain(".sessions-filter-bar {\n    flex-direction: column;");
  });
});

describe("overview access grid styles", () => {
  it("keeps access fields and native controls within the card", () => {
    const css = readComponentsCss();

    expect(css).toContain(
      "grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr));",
    );
    expect(css).toContain(".ov-access-grid .field {\n  min-width: 0;");
    expect(css).toContain(".ov-access-grid .field input,\n.ov-access-grid .field select {");
    expect(css).toContain("box-sizing: border-box;");
    expect(css).toContain("width: 100%;");
  });
});

describe("Live Agent Workspace custom identity sprites", () => {
  it("keeps project rooms stacked as full-width scroll sections", () => {
    const css = readAgentsCss();

    expect(css).toContain(".agent-room-grid {\n  display: grid;\n  grid-template-columns: 1fr;");
    expect(css).toContain(".agent-room-project {\n  position: relative;\n  display: grid;");
    expect(css).toContain("width: 100%;");
    expect(css).toContain("box-sizing: border-box;");
    expect(css).toContain(".agent-room-project__marker {");
    expect(css).toContain(".agent-room-project__workers {\n  display: grid;");
    expect(css).toContain("grid-template-columns: repeat(auto-fill, minmax(126px, 154px));");
    expect(css).not.toContain(
      "  .agent-room-grid {\n    min-width: 0;\n    grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));",
    );
  });

  it("keeps room projects render-virtualized for large agent dashboards", () => {
    const css = readAgentsCss();

    expect(css).toContain(
      ".agent-room-project {\n  position: relative;\n  display: grid;\n  gap: 12px;",
    );
    expect(css).toContain("content-visibility: auto;");
    expect(css).toContain("contain-intrinsic-size: 430px;");
  });

  it("keeps Todd Stanski and Einstein distinct from the generic worker sprite", () => {
    const css = readAgentsCss();

    expect(css).toContain('.agent-room-worker[data-agent-id="main"] .agent-room-worker__head');
    expect(css).toContain('.agent-room-worker[data-agent-id="main"] .agent-room-worker__body');
    expect(css).toContain(
      '.agent-room-worker[data-agent-id="main"] .agent-room-worker__body::before',
    );
    expect(css).toContain(
      '.agent-room-worker[data-agent-id="main"] .agent-room-worker__body::after',
    );
    expect(css).toContain("#8d9397");
    expect(css).toContain("#f2c442");
    expect(css).toContain("#e7c056");
    expect(css).toContain('url("../assets/agent-room/todd-stanski-16bit.png")');
    expect(css).toContain(
      '.agent-room-worker[data-agent-id="strategic-director"] .agent-room-worker__head',
    );
    expect(css).toContain(
      '.agent-room-worker[data-agent-id="strategic-director"] .agent-room-worker__body',
    );
    expect(css).toContain('url("../assets/agent-room/einstein-16bit.png")');
    expect(css).toContain("#fff9df");
    expect(css).toContain("#61272d");
  });
});
