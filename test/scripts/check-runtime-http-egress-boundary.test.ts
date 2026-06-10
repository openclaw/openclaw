// Runtime HTTP egress boundary tests cover raw fetch and retired guard checks.
import { describe, expect, it } from "vitest";
import { collectRuntimeHttpEgressBoundaryViolations } from "../../scripts/check-runtime-http-egress-boundary.mjs";

function collect(files: Record<string, string>): string[] {
  return collectRuntimeHttpEgressBoundaryViolations(Object.keys(files), (file) => {
    const source = files[file];
    if (source === undefined) {
      throw new Error(`missing fixture: ${file}`);
    }
    return source;
  });
}

describe("check-runtime-http-egress-boundary", () => {
  it("catches representative raw runtime fetches", () => {
    const violations = collect({
      "src/agents/example-runtime.ts":
        "export async function run(url: string) { return fetch(url); }",
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("raw runtime fetch must use src/infra/net/egress-fetch.ts");
  });

  it("catches raw fetch in link-understanding", () => {
    const violations = collect({
      "src/link-understanding/runner.ts":
        "export async function run(url: string) { return fetch(url); }",
    });

    expect(violations).toEqual([expect.stringContaining("src/link-understanding/runner.ts")]);
    expect(violations[0]).toContain("raw runtime fetch must use src/infra/net/egress-fetch.ts");
  });

  it("catches raw fetch in app-owned arbitrary URL tool paths", () => {
    const violations = collect({
      "src/agents/tools/web-fetch.ts":
        "export async function run(url: string) { return globalThis.fetch(url); }",
    });

    expect(violations).toEqual([expect.stringContaining("src/agents/tools/web-fetch.ts")]);
    expect(violations[0]).toContain("raw runtime fetch must use src/infra/net/egress-fetch.ts");
  });

  it("catches raw fetch in marketplace archive downloads", () => {
    const violations = collect({
      "src/plugins/marketplace.ts":
        "async function downloadUrlToTempFile(url: string) { return fetch(url); }",
    });

    expect(violations).toEqual([expect.stringContaining("src/plugins/marketplace.ts")]);
    expect(violations[0]).toContain("raw runtime fetch must use src/infra/net/egress-fetch.ts");
  });

  it("catches raw fetch in skill install downloads", () => {
    const violations = collect({
      "src/skills/lifecycle/install-download.ts":
        "async function downloadFile(url: string) { return globalThis.fetch(url); }",
    });

    expect(violations).toEqual([
      expect.stringContaining("src/skills/lifecycle/install-download.ts"),
    ]);
    expect(violations[0]).toContain("raw runtime fetch must use src/infra/net/egress-fetch.ts");
  });

  it("allows documented transport exceptions", () => {
    const violations = collect({
      "extensions/telegram/src/fetch.ts":
        'import { fetch as undiciFetch } from "undici"; export async function run(url: string) { return undiciFetch(url); }',
    });

    expect(violations).toEqual([]);
  });

  it("catches retired guard vocabulary", () => {
    const violations = collect({
      "src/agents/example-runtime.ts":
        'import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime"; export const run = fetchWithSsrFGuard;',
    });

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("retired fetchWithSsrFGuard vocabulary"),
        expect.stringContaining("retired openclaw/plugin-sdk/ssrf-runtime vocabulary"),
      ]),
    );
  });

  it("catches removed public SSRF SDK subpaths", () => {
    const violations = collect({
      "src/agents/example-runtime.ts":
        'import { isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-policy"; import { resolvePinnedHostname } from "openclaw/plugin-sdk/ssrf-dispatcher"; import { internal } from "openclaw/plugin-sdk/ssrf-runtime-internal";',
    });

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("retired openclaw/plugin-sdk/ssrf-policy vocabulary"),
        expect.stringContaining("retired openclaw/plugin-sdk/ssrf-dispatcher vocabulary"),
        expect.stringContaining("retired openclaw/plugin-sdk/ssrf-runtime-internal vocabulary"),
      ]),
    );
  });

  it("catches public fetch-runtime re-exports of retired SSRF APIs", () => {
    const violations = collect({
      "src/plugin-sdk/fetch-runtime.ts":
        'export { createPinnedLookup } from "../infra/net/ssrf.js"; export type { PinnedDispatcherPolicy } from "../infra/net/ssrf.js";',
    });

    expect(violations).toEqual([
      expect.stringContaining(
        "fetch-runtime must not export retired SSRF guard or pinned-dispatcher APIs",
      ),
    ]);
  });

  it("catches old per-call guard plumbing", () => {
    const violations = collect({
      "src/agents/example-runtime.ts":
        "export async function run(url: string, ssrfPolicy: unknown) { return fetchWithResponseRelease({ url, ssrfPolicy }); }",
    });

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("retired generic ssrfPolicy fetch plumbing vocabulary"),
      ]),
    );
  });
});
