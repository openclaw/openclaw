import { describe, expect, it } from "vitest";
import {
  collectEnvSecretRefIds,
  copyConfigResolutionFactsThroughRewrite,
  createConfigResolutionFacts,
  getAuthoredConfigSecretRef,
  getConfigResolutionFacts,
  getResolvedConfigEnvSecretRef,
  hasUnresolvedConfigPath,
  setConfigResolutionFacts,
} from "./resolution-facts.js";

describe("resolution facts through config rewrites", () => {
  it.each<{
    name: string;
    path: string;
    source: object;
    target: object;
    survives: boolean;
  }>([
    {
      name: "array item",
      path: "items[0].key",
      source: { items: [{ key: "value" }] },
      target: { items: [{ key: "value" }] },
      survives: true,
    },
    {
      name: "quoted numeric key",
      path: 'items["0"].key',
      source: { items: { "0": { key: "value" } } },
      target: { items: { "0": { key: "value" } } },
      survives: true,
    },
    {
      name: "array changed to record",
      path: "items[0].key",
      source: { items: [{ key: "value" }] },
      target: { items: { "0": { key: "value" } } },
      survives: false,
    },
    {
      name: "record changed to array",
      path: 'items["0"].key',
      source: { items: { "0": { key: "value" } } },
      target: { items: [{ key: "value" }] },
      survives: false,
    },
    {
      name: "overwritten value",
      path: "key",
      source: { key: "before" },
      target: { key: "after" },
      survives: false,
    },
    {
      name: "moved value",
      path: "key",
      source: { key: "value" },
      target: { relocated: "value" },
      survives: false,
    },
    {
      name: "two missing paths",
      path: "missing",
      source: {},
      target: {},
      survives: false,
    },
    {
      name: "undefined own values",
      path: "key",
      source: { key: undefined },
      target: { key: undefined },
      survives: true,
    },
    {
      name: "removed undefined value",
      path: "key",
      source: { key: undefined },
      target: {},
      survives: false,
    },
    {
      name: "inherited source",
      path: "key",
      source: Object.create({ key: "value" }),
      target: { key: "value" },
      survives: false,
    },
    {
      name: "inherited target",
      path: "key",
      source: { key: "value" },
      target: Object.create({ key: "value" }),
      survives: false,
    },
    {
      name: "sparse arrays",
      path: "items[0]",
      source: { items: Array(1) },
      target: { items: Array(1) },
      survives: false,
    },
    {
      name: "malformed path",
      path: "items[0]tail",
      source: { items: ["value"] },
      target: { items: ["value"] },
      survives: false,
    },
    {
      name: "blocked path",
      path: "constructor.key",
      source: { constructor: { key: "value" } },
      target: { constructor: { key: "value" } },
      survives: false,
    },
  ])("handles $name without retaining stale provenance", ({ path, source, target, survives }) => {
    setConfigResolutionFacts(
      source,
      createConfigResolutionFacts([], new Map(), "default", new Map([[path, "REWRITE_KEY"]])),
    );
    copyConfigResolutionFactsThroughRewrite(source, target);
    expect(getResolvedConfigEnvSecretRef(target, path)?.id ?? null).toBe(
      survives ? "REWRITE_KEY" : null,
    );
    expect(collectEnvSecretRefIds(target)).toEqual(new Set(survives ? ["REWRITE_KEY"] : []));
    expect(collectEnvSecretRefIds(source)).toEqual(new Set(["REWRITE_KEY"]));
    expect(getConfigResolutionFacts(target)).not.toBeNull();
  });

  it("carries pending references and invalidates their unresolved-path facts together", () => {
    const source = { keep: "${PENDING_KEEP}", drop: "${PENDING_DROP}" };
    setConfigResolutionFacts(
      source,
      createConfigResolutionFacts(
        [
          { configPath: "keep", varName: "PENDING_KEEP" },
          { configPath: "drop", varName: "PENDING_DROP" },
        ],
        new Map([
          ["keep", "PENDING_KEEP"],
          ["drop", "PENDING_DROP"],
        ]),
      ),
    );
    const target = { keep: source.keep };
    copyConfigResolutionFactsThroughRewrite(source, target);
    expect(hasUnresolvedConfigPath(target, "keep")).toBe(true);
    expect(hasUnresolvedConfigPath(target, "drop")).toBe(false);
    expect(getAuthoredConfigSecretRef(target, "keep")?.id).toBe("PENDING_KEEP");
    expect(getAuthoredConfigSecretRef(target, "drop")).toBeNull();
  });

  it("clears target facts when the source has no authoritative resolution", () => {
    const target = { key: "value" };
    setConfigResolutionFacts(
      target,
      createConfigResolutionFacts([], new Map(), "default", new Map([["key", "OLD_KEY"]])),
    );
    copyConfigResolutionFactsThroughRewrite({ key: "value" }, target);
    expect(getConfigResolutionFacts(target)).toBeNull();
  });
});
