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
  const array = () => ({ items: [{ key: "value" }] });
  const record = () => ({ items: { "0": { key: "value" } } });
  it.each<[string, string, object, object, boolean]>([
    ["array item", "items[0].key", array(), array(), true],
    ["array changed to record", "items[0].key", array(), record(), false],
    ["record changed to array", 'items["0"].key', record(), array(), false],
    ["two missing paths", "missing", {}, {}, false],
    ["undefined own values", "key", { key: undefined }, { key: undefined }, true],
    ["removed undefined value", "key", { key: undefined }, {}, false],
    ["inherited source", "key", Object.create({ key: "value" }), { key: "value" }, false],
    ["inherited target", "key", { key: "value" }, Object.create({ key: "value" }), false],
    ["sparse arrays", "items[0]", { items: Array(1) }, { items: Array(1) }, false],
    ["malformed path", "items[0]tail", { items: ["value"] }, { items: ["value"] }, false],
    [
      "blocked path",
      "constructor.key",
      { constructor: { key: "value" } },
      { constructor: { key: "value" } },
      false,
    ],
  ])("handles %s without retaining stale provenance", (_name, path, source, target, survives) => {
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
    const pending = new Map([
      ["keep", "PENDING_KEEP"],
      ["drop", "PENDING_DROP"],
    ]);
    setConfigResolutionFacts(
      source,
      createConfigResolutionFacts(
        [...pending].map(([configPath, varName]) => ({ configPath, varName })),
        pending,
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
