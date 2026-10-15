import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
      longBefore = Array.from(
        { length: 64 },
        (_, i) => "const before" + i + ' = "' + identifier() + '";',
      );
      longAfter = Array.from(
        { length: 64 },
        (_, i) => "const after" + i + ' = "' + identifier() + '";',
      );
      await writeFile(path.join(workspace, "example.ts"), before.join("\n") + "\n");
      await writeFile(path.join(workspace, "large.ts"), longBefore.join("\n") + "\n");
      await writeFile(
        path.join(workspace, "gapped.ts"),
        [
          "function unknown() {",
          ...Array.from({ length: 90 }, (_, i) => "  const value" + i + " = " + i + ";"),
          "  return 1;",
          "}",
        ].join("\n") + "\n",
      );
      git("add", ".");
      git("commit", "-m", "Synthetic diff baseline");
      await writeFile(path.join(workspace, "example.ts"), after.join("\n") + "\n");
      await writeFile(path.join(workspace, "large.ts"), longAfter.join("\n") + "\n");
      await writeFile(
        path.join(workspace, "gapped.ts"),
        [
          "function unknown() {",
          ...Array.from(
            { length: 90 },
            (_, i) => "  const value" + i + " = " + (i === 0 ? 999 : i) + ";",
          ),
          "  return 2;",
          "}",
        ].join("\n") + "\n",
      );
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
  it("folds actual sessions.diff source without concealing edits by default", async () => {
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
    expect(
      (
        await rpc("sessions.create", {
          agentId: "main",
          key,
          label: "Manual code folding proof",
          cwd: workspace,
        })
      ).ok,
    ).toBe(true);
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
          if (/\/assets\/index-[^/]+\.js$/.test(new URL(response.url()).pathname)) {
            void response.body().then((bytes) =>
              servedAssets.push({
                url: new URL(response.url()).pathname,
                sha256: createHash("sha256").update(bytes).digest("hex"),
              }),
            );
          }
        });
        await page.goto(url.toString());
        await enterControlUiSession(page);
        await waitForControlUiGatewayReady(page);
        await activateChatHeaderPanelAction(page, "Show session changes");
        await focusChatSidePanel(page);
        const panel = page.locator(".session-diff");
        const file = panel.locator(".session-diff__file").filter({ hasText: "example.ts" });
        await file.locator(".session-diff__code-toggle").first().waitFor();
        expect(
          await file
            .locator(".session-diff-split__side--left .session-diff-split__text")
            .allTextContents(),
        ).toEqual([before[1], before[3]]);
        expect(
          await file
            .locator(".session-diff-split__side--right .session-diff-split__text")
            .allTextContents(),
        ).toEqual([after[1], after[3]]);
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
          await section.locator(".session-diff__file-toggle").click();
        }
        await take("before-expanded");
        await file.getByRole("button", { name: "Collapse code at line 1", exact: true }).click();
        await file.locator(".session-diff__code-placeholder").waitFor();
        expect(await file.locator(".session-diff-split__row").count()).toBe(1);
        expect(await file.locator(".session-diff-split__text").allTextContents()).toEqual([
          before[0],
        ]);
        expect(await file.locator(".session-diff__code-placeholder").textContent()).toContain("+2");
        expect(await file.locator(".session-diff__code-placeholder").textContent()).toContain("-2");
        await take("after-folded-split");
        const view = async (name: string) => {
          await panel.getByRole("button", { name: "Change view options" }).click();
          await page.getByRole("menuitem", { name, exact: true }).click();
        };
        await view("Switch to Unified Diff");
        expect(await file.locator(".chat-diff__row").count()).toBe(1);
        await take("after-folded-unified");
        for (const section of await otherFiles.all()) {
          await section.locator(".session-diff__file-toggle").click();
        }
        await file.locator(".session-diff__code-placeholder").click();
        expect(
          await file.locator(".chat-diff__row--del .chat-diff__text").allTextContents(),
        ).toEqual([before[1], before[3]]);
        expect(
          await file.locator(".chat-diff__row--add .chat-diff__text").allTextContents(),
        ).toEqual([after[1], after[3]]);
        const large = panel.locator(".session-diff__file").filter({ hasText: "large.ts" });
        expect(
          await large.locator(".chat-diff__row--del .chat-diff__text").allTextContents(),
        ).toEqual(longBefore);
        expect(
          await large.locator(".chat-diff__row--add .chat-diff__text").allTextContents(),
        ).toEqual(longAfter);
        const gapped = panel.locator(".session-diff__file").filter({ hasText: "gapped.ts" });
        expect(await gapped.locator(".session-diff__code-toggle").count()).toBe(0);
        await gapped.getByRole("button", { name: /Show all .* unmodified lines/ }).click();
        await gapped.locator(".session-diff__code-toggle").first().waitFor();
        await view("Switch to Split Diff");
        expect(
          await large
            .locator(
              ".session-diff-split__side--left.session-diff-split__side--filled .session-diff-split__text",
            )
            .allTextContents(),
        ).toEqual(longBefore);
        expect(
          await large
            .locator(
              ".session-diff-split__side--right.session-diff-split__side--filled .session-diff-split__text",
            )
            .allTextContents(),
        ).toEqual(longAfter);
        await file.getByRole("button", { name: "Collapse code at line 3", exact: true }).click();
        expect(await file.locator(".session-diff__code-placeholder").count()).toBe(1);
        await panel.getByRole("button", { name: "Refresh changes" }).click();
        await expect.poll(() => panel.getAttribute("aria-busy")).toBe("false");
        expect(await file.locator(".session-diff__code-placeholder").count()).toBe(1);
        await file.getByRole("button", { name: "Collapse code at line 1", exact: true }).click();
        await file.getByRole("button", { name: "Expand code at line 1", exact: true }).click();
        expect(await file.locator(".session-diff__code-placeholder").count()).toBe(1);
        const action = async (name: string) => {
          await file.getByRole("button", { name: "Actions for example.ts" }).click();
          await page.getByRole("menuitem", { name, exact: true }).click();
        };
        await action("Expand Code");
        expect(await file.locator(".session-diff__code-placeholder").count()).toBe(0);
        await action("Collapse Functions and Classes");
        expect(await file.locator(".session-diff-split__row").count()).toBe(1);
        await writeFile(
          path.join(workspace, "example.ts"),
          after.join("\n").replace('"empty"', '"nothing"') + "\n",
        );
        const refreshStart = await page.evaluate(() => performance.now());
        await panel.getByRole("button", { name: "Refresh changes" }).click();
        await file.getByText('return "nothing";', { exact: true }).waitFor();
        expect(await file.locator(".session-diff__code-placeholder").count()).toBe(0);
        report.changedPatchRefreshMs =
          (await page.evaluate(
            () =>
              new Promise<number>((resolve) => {
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve(performance.now())),
                );
              }),
          )) - refreshStart;
        await file.getByRole("button", { name: "Collapse code at line 1", exact: true }).waitFor();
        await action("Collapse Code");
        expect(await file.locator(".session-diff-split__row").count()).toBe(1);
        await action("Expand Code");
        expect(await file.locator(".session-diff__code-placeholder").count()).toBe(0);
        for (const asset of servedAssets) {
          expect(
            createHash("sha256")
              .update(await readFile(path.join(process.cwd(), "dist/control-ui", asset.url)))
              .digest("hex"),
          ).toBe(asset.sha256);
        }
        expect(servedAssets.length).toBeGreaterThan(0);
        report.assets = servedAssets;
        report.browser = page.context().browser()?.version();
        report.assertions =
          "default-open; DOM absence; split/unified retention; source/highlight fidelity; nested state; real gap expansion; 64 long replacements; refresh retention; file-menu actions; real patch invalidation";
        await writeFile(
          path.join(suite.artifactDir, "proof.json"),
          JSON.stringify(report, null, 2),
        );
        console.info("Session diff folding proof.json:", JSON.stringify(report));
      },
    );
  }, 120_000);
});
