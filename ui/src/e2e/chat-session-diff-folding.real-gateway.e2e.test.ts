import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import {
  activateChatHeaderPanelAction,
  focusChatSidePanel,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const profile = "diff-code-fold-live";
const key = "agent:main:folding-proof";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const before = [
  "export function summarize(count: number) {",
  '  const label = "before";',
  "  if (count > 0) {",
  "    return label + count;",
  "  }",
  '  return "empty";',
  "}",
];
const after = before.map((line) =>
  line.replace('"before"', '"after"').replace("label + count", "label + count * 2"),
);
let instance: OpenClawTestInstance;
let workspace: string;
let longBefore: string[], longAfter: string[];

async function writeSources(changed: boolean) {
  const sources = {
    "example.ts": changed ? after : before,
    "large.ts": changed ? longAfter : longBefore,
    "gapped.ts": [
      "function unknown() {",
      ...Array.from(
        { length: 90 },
        (_, i) => `  const value${i} = ${changed && i === 0 ? 999 : i};`,
      ),
      `  return ${changed ? 2 : 1};`,
      "}",
    ],
  };
  for (const [name, lines] of Object.entries(sources)) {
    await writeFile(path.join(workspace, name), lines.join("\n") + "\n");
  }
}

async function expectLines(file: Locator, selector: string, lines: (string | undefined)[]) {
  expect(await file.locator(selector).allTextContents()).toEqual(lines);
}
const suite = createControlUiE2eSuite({
  name: "manual code folding through a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: profile,
      entrypoint: ["scripts/run-node.mjs", "--profile", profile],
      env: { OPENCLAW_PROFILE: profile },
    });
    instance = owner;
    workspace = owner.state.path("workspace");
    try {
      await mkdir(workspace, { recursive: true });
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
      git("init", "-b", "main");
      git("config", "user.name", "Synthetic Fixture");
      git("config", "user.email", "fixture@example.invalid");
      let seed = 123456789;
      const identifier = () =>
        Array.from({ length: 680 }, () => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"[seed % 52];
        }).join("");
      const longLines = (label: string) =>
        Array.from({ length: 64 }, (_, i) => `const ${label}${i} = "${identifier()}";`);
      longBefore = longLines("before");
      longAfter = longLines("after");
      await writeSources(false);
      git("add", ".");
      git("commit", "-m", "Synthetic diff baseline");
      await writeSources(true);
      await owner.state.writeConfig({
        agents: {
          defaults: { workspace, skipBootstrap: true, heartbeat: { every: "0m" } },
          entries: { main: { workspace, name: "Folding proof" } },
        },
        gateway: {
          port: owner.port,
          auth: { mode: "token", token: owner.gatewayToken },
          controlUi: { enabled: true },
        },
      });
      ensureGatewayOwnerProfile("Synthetic Folding Viewer", { env: owner.env });
      await owner.startGateway();
      return { baseUrl: "http://127.0.0.1:" + owner.port + "/", close: () => owner.cleanup() };
    } catch (error) {
      await runQaGatewayFixture(
        async () => {
          throw error;
        },
        () => owner.cleanup(),
      );
      throw error;
    }
  },
});

suite.define(() => {
  it("folds actual sessions.diff source without concealing edits in expanded files", async () => {
    const rpc = async (method: string, params: object) => {
      const result = await instance.cli([
        "gateway",
        "call",
        method,
        "--params",
        JSON.stringify(params),
        "--json",
      ]);
      if (result.code !== 0) {
        throw new Error(
          method + " failed: " + result.stderr.replaceAll(instance.gatewayToken, "[fixture token]"),
        );
      }
      return JSON.parse(result.stdout);
    };
    const created = await rpc("sessions.create", {
      agentId: "main",
      key,
      label: "Manual code folding proof",
      cwd: workspace,
    });
    expect(created.ok).toBe(true);
    const diff = await rpc("sessions.diff", { sessionKey: key });
    expect(diff.files.map((file: { path: string }) => file.path)).toEqual([
      "example.ts",
      "gapped.ts",
      "large.ts",
    ]);
    const report: { [key: string]: unknown } = {
      files: diff.files.map((file: { path: string; additions: number; deletions: number }) => ({
        path: file.path,
        added: file.additions,
        removed: file.deletions,
      })),
      profile,
      port: instance.port,
    };
    const handoff = await rpc("health", {}).then(() => instance.cli(["dashboard", "--json"]));
    expect(handoff.code).toBe(0);
    const dashboard = JSON.parse(handoff.stdout);
    const url = new URL("chat/main/~key/folding-proof", suite.server.baseUrl);
    url.hash = new URL(dashboard.browserUrl).hash;
    await suite.withPage(
      { viewport: { width: 1440, height: 950 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        await page.addInitScript(() => {
          localStorage.setItem(
            "openclaw:control-ui:community-invite:v2",
            JSON.stringify({ dismissedAtMs: 1770000000000 }),
          );
          localStorage.setItem(
            "openclaw.control.sessionDiff.v1",
            JSON.stringify({ split: true, wrap: false }),
          );
        });
        const servedAssets: { url: string; sha256: string }[] = [];
        page.on("response", (response) => {
          const assetUrl = new URL(response.url()).pathname;
          if (/\/assets\/index-[^/]+\.js$/.test(assetUrl)) {
            void response
              .body()
              .then((bytes) => servedAssets.push({ url: assetUrl, sha256: sha256(bytes) }));
          }
        });
        await page.goto(url.toString());
        await enterControlUiSession(page);
        await waitForControlUiGatewayReady(page);
        await activateChatHeaderPanelAction(page, "Show session changes");
        await focusChatSidePanel(page);
        const panel = page.locator(".session-diff");
        const file = panel.locator(".session-diff__file").filter({ hasText: "example.ts" });
        const fileToggle = file.locator(".session-diff__file-toggle");
        await fileToggle.waitFor();
        expect(await fileToggle.getAttribute("aria-expanded")).toBe("false");
        await fileToggle.click();
        const codeToggle = file.locator(".session-diff__code-toggle");
        const placeholder = file.locator(".session-diff__code-placeholder");
        const button = (name: string) => file.getByRole("button", { name, exact: true });
        await codeToggle.first().waitFor();
        const splitLeft = ".session-diff-split__side--left .session-diff-split__text";
        const splitRight = ".session-diff-split__side--right .session-diff-split__text";
        await expectLines(file, splitLeft, [before[1], before[3]]);
        await expectLines(file, splitRight, [after[1], after[3]]);
        expect(await file.locator(".chat-diff__change--add").count()).toBeGreaterThan(0);
        const take = async (name: string) => {
          const frame = await takeControlUiScreenshotFrame(
            page,
            panel,
            [file.locator(".session-diff__filename")],
            { elements: [file], animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
        };
        const otherFiles = panel
          .locator(".session-diff__file")
          .filter({ hasNotText: "example.ts" });
        for (const section of await otherFiles.all()) {
          const toggle = section.locator(".session-diff__file-toggle");
          if ((await toggle.getAttribute("aria-expanded")) === "true") {
            await toggle.click();
          }
        }
        await take("before-expanded");
        await button("Collapse code at line 1").click();
        await placeholder.waitFor();
        expect(await file.locator(".session-diff-split__row").count()).toBe(1);
        await expectLines(file, ".session-diff-split__text", [before[0]]);
        const foldedText = await placeholder.textContent();
        expect(foldedText).toContain("+2");
        expect(foldedText).toContain("-2");
        await take("after-folded-split");
        await panel
          .getByRole("button", { name: "Diff mode: split. Switch to next mode", exact: true })
          .click();
        await panel
          .getByRole("button", { name: "Diff mode: auto. Switch to next mode", exact: true })
          .click();
        expect(await file.locator(".chat-diff__row").count()).toBe(1);
        await take("after-folded-unified");
        for (const section of await otherFiles.all()) {
          await section.locator(".session-diff__file-toggle").click();
        }
        await placeholder.click();
        const unifiedDel = ".chat-diff__row--del .chat-diff__text";
        const unifiedAdd = ".chat-diff__row--add .chat-diff__text";
        await expectLines(file, unifiedDel, [before[1], before[3]]);
        await expectLines(file, unifiedAdd, [after[1], after[3]]);
        const large = panel.locator(".session-diff__file").filter({ hasText: "large.ts" });
        await expectLines(large, unifiedDel, longBefore);
        await expectLines(large, unifiedAdd, longAfter);
        const gapped = panel.locator(".session-diff__file").filter({ hasText: "gapped.ts" });
        expect(await gapped.locator(".session-diff__code-toggle").count()).toBe(0);
        await gapped.getByRole("button", { name: /^\d+ unmodified lines$/ }).click();
        await gapped.locator(".session-diff__code-toggle").first().waitFor();
        await panel
          .getByRole("button", { name: "Diff mode: unified. Switch to next mode", exact: true })
          .click();
        await expectLines(
          large,
          ".session-diff-split__side--left.session-diff-split__side--filled .session-diff-split__text",
          longBefore,
        );
        await expectLines(
          large,
          ".session-diff-split__side--right.session-diff-split__side--filled .session-diff-split__text",
          longAfter,
        );
        await button("Collapse code at line 3").click();
        expect(await placeholder.count()).toBe(1);
        await panel.getByRole("button", { name: "Refresh changes" }).click();
        await expect.poll(() => panel.getAttribute("aria-busy")).toBe("false");
        // Refresh closes file cards; reopening must retain this source's code-fold state.
        expect(await fileToggle.getAttribute("aria-expanded")).toBe("false");
        await fileToggle.click();
        await placeholder.waitFor();
        expect(await placeholder.count()).toBe(1);
        await button("Collapse code at line 1").click();
        await button("Expand code at line 1").click();
        expect(await placeholder.count()).toBe(1);
        const action = async (name: string) => {
          await button("Actions for example.ts").click();
          await page.getByRole("menuitem", { name, exact: true }).click();
        };
        await action("Expand Code");
        expect(await placeholder.count()).toBe(0);
        await action("Collapse Functions and Classes");
        expect(await file.locator(".session-diff-split__row").count()).toBe(1);
        await writeFile(
          path.join(workspace, "example.ts"),
          after.join("\n").replace('"empty"', '"nothing"') + "\n",
        );
        const refreshStart = await page.evaluate(() => performance.now());
        await panel.getByRole("button", { name: "Refresh changes" }).click();
        await expect.poll(() => panel.getAttribute("aria-busy")).toBe("false");
        expect(await fileToggle.getAttribute("aria-expanded")).toBe("false");
        await fileToggle.click();
        await file.getByText('return "nothing";', { exact: true }).waitFor();
        expect(await placeholder.count()).toBe(0);
        report.changedPatchRefreshMs =
          (await page.evaluate(
            () =>
              new Promise<number>((resolve) => {
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve(performance.now())),
                );
              }),
          )) - refreshStart;
        await button("Collapse code at line 1").waitFor();
        await action("Collapse Code");
        expect(await file.locator(".session-diff-split__row").count()).toBe(1);
        await action("Expand Code");
        expect(await placeholder.count()).toBe(0);
        for (const asset of servedAssets) {
          const built = await readFile(path.join(process.cwd(), "dist/control-ui", asset.url));
          expect(sha256(built)).toBe(asset.sha256);
        }
        expect(servedAssets.length).toBeGreaterThan(0);
        report.assets = servedAssets;
        report.browser = page.context().browser()?.version();
        report.assertions =
          "default-collapsed; explicit file expansion; DOM absence; split/unified retention; source/highlight fidelity; nested state; real gap expansion; 64 long replacements; refresh retention; file-menu actions; real patch invalidation";
        await writeFile(
          path.join(suite.artifactDir, "proof.json"),
          JSON.stringify(report, null, 2),
        );
        console.info("Session diff folding proof.json:", JSON.stringify(report));
      },
    );
  }, 120_000);
});
