import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let instance: OpenClawTestInstance;
const suite = createControlUiE2eSuite({
  name: "Approval lookup admission through a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    instance = await createOpenClawTestInstance({ name: "approval-lookup" });
    try {
      await instance.state.writeConfig({
        gateway: {
          port: instance.port,
          auth: { mode: "token", token: instance.gatewayToken },
          controlUi: { enabled: true },
        },
      });
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close: () => instance.cleanup() };
    } catch (error) {
      return runQaGatewayFixture(
        async () => {
          throw error;
        },
        () => instance.cleanup(),
      );
    }
  },
});

async function runCli(args: string[]) {
  const result = await instance.cli(args);
  expect(result.code).toBe(0);
  return result.stdout;
}

suite.define(() => {
  it("coalesces tab refreshes while a real approval lookup reply is held", async (test) => {
    await suite.runScenario(test, {
      retainedState: () => instance.stateDir,
      run: async () => {
        const context = await suite.newBrowserContext({
          locale: "en-US",
          viewport: { width: 1200, height: 800 },
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const inFlight = new Set<string>();
        const release: (() => void)[] = [];
        let holding = false;
        let requests = 0;
        let peak = 0;
        await page.routeWebSocket("**", (socket) => {
          const server = socket.connectToServer();
          socket.onMessage((message) => {
            const frame: unknown = JSON.parse(message.toString());
            if (
              isRecord(frame) &&
              frame.method === "approval.get" &&
              typeof frame.id === "string"
            ) {
              requests += 1;
              inFlight.add(frame.id);
              peak = Math.max(peak, inFlight.size);
            }
            server.send(message);
          });
          server.onMessage((message) => {
            const frame: unknown = JSON.parse(message.toString());
            const id = isRecord(frame) && typeof frame.id === "string" ? frame.id : undefined;
            const deliver = () => {
              if (id) {
                inFlight.delete(id);
              }
              socket.send(message);
            };
            if (holding && id && inFlight.has(id)) {
              release.push(deliver);
            } else {
              deliver();
            }
          });
        });
        try {
          await pairControlUiPage(page, runCli);
          const id = "approval-lookup-proof";
          const accepted: unknown = JSON.parse(
            await runCli([
              "gateway",
              "call",
              "exec.approval.request",
              "--json",
              "--params",
              JSON.stringify({
                id,
                command: "printf synthetic-approval",
                host: "gateway",
                twoPhase: true,
                suppressDelivery: true,
                requireDeliveryRoute: false,
                timeoutMs: 60_000,
              }),
            ]),
          );
          expect(accepted).toMatchObject({ status: "accepted", id });
          await page.goto(new URL(`/approve/${id}`, suite.server.baseUrl).href);
          await page.getByText("Waiting for your decision", { exact: true }).waitFor();
          const script = await page
            .locator('script[type="module"][src]')
            .first()
            .getAttribute("src");
          if (!script?.startsWith("/assets/")) {
            throw new Error("Expected the built Control UI entrypoint");
          }
          const asset = await context.request.get(new URL(script, suite.server.baseUrl).href);
          expect(asset.ok()).toBe(true);
          const served = await asset.body();
          expect(served.equals(await readFile(path.join("dist/control-ui", script.slice(1))))).toBe(
            true,
          );
          const uiAssetSha256 = createHash("sha256").update(served).digest("hex");
          await expect.poll(() => inFlight.size).toBe(0);
          // Only the external visibility input and reply latency are simulated.
          // Every request and response still traverses the real Gateway.
          const visibility = async (value: DocumentVisibilityState) => {
            await page.evaluate((state) => {
              Object.defineProperty(document, "visibilityState", {
                configurable: true,
                value: state,
              });
              document.dispatchEvent(new Event("visibilitychange"));
            }, value);
          };
          await visibility("hidden");
          const initial = requests;
          peak = 0;
          holding = true;
          await visibility("visible");
          await expect.poll(() => release.length).toBe(1);
          for (let cycle = 0; cycle < 4; cycle += 1) {
            await visibility("hidden");
            await visibility("visible");
          }
          expect(requests - initial).toBe(1);
          expect(peak).toBe(1);
          holding = false;
          for (const deliver of release) {
            deliver();
          }
          await expect.poll(() => requests - initial).toBe(2);
          await visibility("hidden");
          await expect.poll(() => inFlight.size).toBe(0);
          await page.getByRole("button", { name: "Deny", exact: true }).click();
          await page.getByRole("heading", { name: "Denied here", exact: true }).waitFor();
          expect(requests - initial).toBe(2);
          expect(peak).toBe(1);
          expect(errors).toEqual([]);
          await writeFile(
            path.join(suite.artifactDir, "lookup-counts.json"),
            JSON.stringify({
              visibilityCycles: 5,
              requests: requests - initial,
              peak,
              terminal: "Denied here",
              uiAssetSha256,
            }) + "\n",
          );
        } finally {
          await suite.closeBrowserContext(context);
        }
      },
    });
  });
});
