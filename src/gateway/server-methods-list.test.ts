import { describe, expect, it } from "vitest";
import { GATEWAY_EVENTS, listGatewayMethods } from "./server-methods-list.js";

describe("GATEWAY_EVENTS", () => {
  it("advertises Talk event streams in hello features", () => {
    expect(GATEWAY_EVENTS).toEqual(expect.arrayContaining(["talk.event"]));
    expect(GATEWAY_EVENTS).not.toEqual(
      expect.arrayContaining(["talk.realtime.relay", "talk.transcription.relay"]),
    );
  });
});

describe("listGatewayMethods", () => {
  it("advertises plugin surface refresh for capability rotation", () => {
    expect(listGatewayMethods()).toEqual(expect.arrayContaining(["node.pluginSurface.refresh"]));
  });

  it("advertises task ledger RPCs", () => {
    expect(listGatewayMethods()).toEqual(
      expect.arrayContaining(["tasks.list", "tasks.get", "tasks.cancel"]),
    );
  });

  it("advertises Self-Improvement Governor proposal and scorecard RPCs", () => {
    expect(listGatewayMethods()).toEqual(
      expect.arrayContaining([
        "selfImprovement.auditEvents.list",
        "selfImprovement.scorecard",
        "selfImprovement.health",
        "selfImprovement.productionCheck",
        "selfImprovement.maintenance.run",
        "selfImprovement.analysis.run",
        "selfImprovement.models.preflight",
        "selfImprovement.evals.run",
        "selfImprovement.groups.update",
        "selfImprovement.proposals.list",
        "selfImprovement.proposals.get",
        "selfImprovement.proposals.update",
        "selfImprovement.curator.list",
        "selfImprovement.curator.get",
        "selfImprovement.curator.update",
      ]),
    );
  });

  it("advertises native Pattern Lab dashboard RPCs", () => {
    expect(listGatewayMethods()).toEqual(
      expect.arrayContaining(["patternLab.dashboard.snapshot", "patternLab.assets.approve"]),
    );
  });

  it("advertises the Trading Lab dashboard RPC", () => {
    expect(listGatewayMethods()).toEqual(expect.arrayContaining(["tradingLab.dashboard.snapshot"]));
  });

  it("advertises the SNES Studio benchmark and production-loop RPCs", () => {
    expect(listGatewayMethods()).toEqual(
      expect.arrayContaining([
        "snes.benchmark.latest",
        "snes.glm52.status",
        "snes.mastery.status",
        "snes.proof.run",
        "snes.project.createBlank",
        "snes.toolchain.status",
        "snes.visual.reject",
        "snes.visual.artBible",
        "snes.visual.artSourcePack",
        "snes.visual.compileArt",
        "snes.visual.captureProof",
        "snes.visual.qualityAudit",
        "snes.visual.runtimeAssetTruth",
        "snes.visual.approve",
        "snes.production.status",
        "snes.production.continue",
        "snes.production.retryBlocked",
        "snes.stanski.production.status",
        "snes.stanski.production.continue",
        "snes.stanski.production.retryBlocked",
      ]),
    );
  });

  it("advertises the versioned Talk session RPCs", () => {
    expect(listGatewayMethods()).toEqual(
      expect.arrayContaining([
        "talk.client.create",
        "talk.client.toolCall",
        "talk.session.create",
        "talk.session.join",
        "talk.session.appendAudio",
        "talk.session.startTurn",
        "talk.session.endTurn",
        "talk.session.cancelTurn",
        "talk.session.cancelOutput",
        "talk.session.submitToolResult",
        "talk.session.close",
      ]),
    );
  });
});
