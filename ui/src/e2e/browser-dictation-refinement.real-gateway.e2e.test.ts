import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { rasterizeProofAnnotations } from "../test-helpers/proof-annotations.ts";
import { startDictationSpeechProvider } from "./browser-dictation-refinement-provider.test-support.ts";
import {
  createControlUiE2eSuite,
  type ControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const initialDraft = "Existing draft.";
const finalText = "Do not delete customer_id or -12 mg.";
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const viewport = { width: 1280, height: 1000 };

declare global {
  interface Window {
    dictationProofTracks?: MediaStreamTrack[];
  }
}

async function capture(
  suite: ControlUiE2eSuite,
  page: Page,
  stage: string,
  shell: Locator,
  target: Locator,
  label?: string,
) {
  if (!captureProof) {
    return;
  }
  const frame = await takeControlUiScreenshotFrame(page, shell, [target], {
    elements: [target],
    animations: "disabled",
  });
  await writeFile(path.join(suite.artifactDir, `${stage}-clean.png`), frame.png);
  if (label) {
    const annotations = [
      {
        kind: "outline" as const,
        rect: frame.elements[0]!.bounds,
        text: label,
        labelAt: { x: 24, y: 24 },
        color: "#78D9C5",
      },
    ];
    const annotationFrame = {
      viewport,
      scale: await page.evaluate(() => window.devicePixelRatio),
      annotations,
    };
    await writeFile(
      path.join(suite.artifactDir, `${stage}-annotations.json`),
      JSON.stringify(annotationFrame, null, 2),
    );
    await writeFile(
      path.join(suite.artifactDir, `${stage}-annotated.png`),
      await rasterizeProofAnnotations(suite.browser, { ...annotationFrame, image: frame.png }),
    );
  }
}

for (const mode of ["realtime", "file"] as const) {
  let instance: OpenClawTestInstance;
  let provider: Awaited<ReturnType<typeof startDictationSpeechProvider>>;
  const suite = createControlUiE2eSuite({
    name: `Dictation review through real Gateway ${mode} transcription`,
    startServerBeforeBrowser: true,
    browserLaunchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
    async startServer() {
      provider = await startDictationSpeechProvider();
      const close = async () => {
        try {
          await instance?.cleanup();
        } finally {
          await provider.close();
        }
      };
      try {
        instance = await createOpenClawTestInstance({
          name: `dictation-review-${mode}`,
          env: {
            ...Object.fromEntries(
              Object.keys(process.env)
                .filter((key) =>
                  /(?:_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN|_SECRET|_PASSWORD)$/u.test(key),
                )
                .map((key) => [key, undefined]),
            ),
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            VITEST: undefined,
            DEEPGRAM_API_KEY: "synthetic-unused-key",
            DEEPGRAM_BASE_URL: provider.baseUrl,
          },
          config: {
            gateway: { controlUi: { enabled: true } },
            cron: { enabled: false },
            browser: { enabled: false },
            update: { checkOnStart: false },
            agents: {
              defaults: {
                model: "dictation-fixture/metadata",
                modelPolicy: { allow: ["dictation-fixture/*"] },
                ...(mode === "realtime" ? { voiceModel: "deepgram/nova-3" } : {}),
              },
              entries: { main: { identity: { name: "Dictation fixture" } } },
            },
            models: {
              catalogRefresh: { enabled: false },
              providers: {
                "dictation-fixture": {
                  api: "openai-responses",
                  apiKey: "synthetic-unused-key",
                  baseUrl: provider.baseUrl,
                  request: { allowPrivateNetwork: true },
                  models: [{ id: "metadata", name: "Fixture" }],
                },
                ...(mode === "file"
                  ? {
                      deepgram: {
                        baseUrl: provider.baseUrl,
                        request: { allowPrivateNetwork: true },
                        models: [],
                      },
                    }
                  : {}),
              },
            },
            plugins: { allow: ["deepgram", "openai"] },
            ...(mode === "file"
              ? {
                  tools: {
                    media: {
                      models: [{ provider: "deepgram", model: "nova-3", capabilities: ["audio"] }],
                    },
                  },
                }
              : {}),
          },
        });
        await instance.startGateway();
        return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
      } catch (error) {
        await close();
        throw error;
      }
    },
  });

  suite.define(() => {
    // Only provider I/O and Chromium's microphone source are synthetic.
    it("keeps Stop in finishing until provider completion, inserts only on acceptance, and retires cancelled text", () =>
      suite.withPage(
        {
          locale: "en-US",
          viewport,
          colorScheme: "dark",
          reducedMotion: "reduce",
          permissions: ["microphone"],
        },
        async ({ page }) => {
          const methods: Record<string, number> = {};
          let closedSessions = 0;
          const timings: Record<string, number> = {};
          page.on("websocket", (socket) => {
            socket.on("framesent", ({ payload }) => {
              const frame: { method?: string } = JSON.parse(payload.toString());
              if (frame.method) {
                methods[frame.method] = (methods[frame.method] ?? 0) + 1;
              }
            });
            socket.on("framereceived", ({ payload }) => {
              const frame: { event?: string; payload?: { type?: string } } = JSON.parse(
                payload.toString(),
              );
              if (frame.event === "talk.event" && frame.payload?.type === "close") {
                closedSessions += 1;
              }
            });
          });
          await page.addInitScript(() => {
            const tracks: MediaStreamTrack[] = [];
            window.dictationProofTracks = tracks;
            const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getUserMedia = async (constraints) => {
              const stream = await getUserMedia(constraints);
              tracks.push(...stream.getTracks());
              return stream;
            };
            localStorage.setItem(
              "openclaw:control-ui:community-invite:v2",
              JSON.stringify({ dismissedAtMs: 1770000000000 }),
            );
          });
          let dashboard = await instance.cli(["dashboard", "--json"]);
          await expect
            .poll(
              async () => {
                if (dashboard.code !== 0 && /still preparing/u.test(dashboard.stderr)) {
                  dashboard = await instance.cli(["dashboard", "--json"]);
                }
                return /still preparing/u.test(dashboard.stderr);
              },
              { timeout: 120_000, interval: 1_000 },
            )
            .toBe(false);
          expect(dashboard.code, dashboard.stderr).toBe(0);
          const { browserUrl }: { browserUrl: string } = JSON.parse(dashboard.stdout);
          const url = new URL(browserUrl);
          url.pathname = "/chat";
          await page.goto(url.href);
          await waitForControlUiGatewayReady(page);
          const shell = page.locator(".agent-chat__composer-shell");
          const draft = shell.locator(".agent-chat__composer-combobox textarea");
          const review = shell.locator(".agent-chat__dictation-refinement");
          const status = review.getByRole("status");
          const preview = review.getByRole("textbox", { name: "Text preview", exact: true });
          const attempts = mode === "realtime" ? provider.realtime : provider.files;
          await draft.fill(initialDraft);
          await shell
            .getByRole("button", { name: "Dictation text options", exact: true })
            .filter({ visible: true })
            .click();
          const optIn = review.getByRole("checkbox", {
            name: "Review dictated text before inserting",
          });
          expect(await optIn.isChecked()).toBe(false);
          await capture(suite, page, "default-off", shell, optIn);
          await optIn.check();
          const start = async () => {
            const appended = methods["talk.session.appendAudio"] ?? 0;
            const listening = shell.locator(
              '.agent-chat__dictation-status [data-status="listening"]',
            );
            // At this desktop viewport a tap starts Talk. Hold until dictation latches.
            await shell.getByRole("button", { name: "Start voice input", exact: true }).hover();
            await page.mouse.down();
            try {
              await listening.waitFor();
            } finally {
              await page.mouse.up();
            }
            await expect
              .poll(() => methods["talk.session.appendAudio"] ?? 0)
              .toBeGreaterThan(appended);
          };
          const stop = async (index: number) => {
            await shell
              .getByRole("button", { name: "Finish and review text", exact: true })
              .and(shell.locator("button.chat-send-btn--dictation-commit"))
              .click();
            await expect.poll(() => attempts[index]?.finishing).toBe(true);
            expect(attempts[index]!.audioBytes).toBeGreaterThan(0);
            await expect
              .poll(() => status.textContent())
              .toBe("Finishing text. The microphone is off.");
            expect(
              await page.evaluate(() => {
                const tracks = window.dictationProofTracks;
                return Boolean(
                  tracks?.length && tracks.every((track) => track.readyState === "ended"),
                );
              }),
            ).toBe(true);
          };
          try {
            await start();
            const stoppedAt = performance.now();
            await stop(0);
            await capture(suite, page, "finishing", shell, status);
            attempts[0]!.release(finalText);
            await preview.waitFor({ timeout: 15_000 });
            timings.stopToPreviewMs = performance.now() - stoppedAt;
            expect(closedSessions).toBe(1);
            expect(await preview.inputValue()).toBe(finalText);
            expect(await draft.inputValue()).toBe(initialDraft);
            expect(methods["chat.send"] ?? 0).toBe(0);
            await capture(
              suite,
              page,
              "review-ready",
              shell,
              status,
              "Final transcript stays available for review",
            );
            await review.getByRole("button", { name: "Use reviewed text", exact: true }).click();
            await expect.poll(() => draft.inputValue()).toBe(`${initialDraft} ${finalText}`);
            await preview.waitFor({ state: "detached" });
            expect(methods["chat.send"] ?? 0).toBe(0);
            await capture(suite, page, "accepted", shell, draft);

            await start();
            await stop(1);
            await review
              .getByRole("button", { name: "Cancel text refinement", exact: true })
              .click();
            await expect
              .poll(() => status.textContent())
              .toBe("Text refinement cancelled. Your draft is preserved.");
            attempts[1]!.release("This cancelled text must not be inserted.");
            await expect.poll(() => attempts[1]!.closed).toBe(true);
            await expect.poll(() => closedSessions).toBe(2);
            expect(await preview.count()).toBe(0);
            expect(await draft.inputValue()).toBe(`${initialDraft} ${finalText}`);
            expect(methods["chat.send"] ?? 0).toBe(0);
            expect(provider.unexpected).toEqual([]);
            await capture(suite, page, "cancelled", shell, status);
          } finally {
            await writeFile(
              path.join(suite.artifactDir, "receipt.json"),
              JSON.stringify(
                {
                  mode,
                  methods,
                  closedSessions,
                  timings,
                  boundary:
                    "Production Gateway and speech adapters; native Chromium fake microphone; synthetic loopback external provider I/O",
                  attempts: attempts.map(({ audioBytes, finishing, closed }) => ({
                    audioBytes,
                    finishing,
                    closed,
                  })),
                  liveProvider: false,
                  physicalMicrophone: false,
                },
                null,
                2,
              ),
            );
          }
        },
      ));
  });
}
