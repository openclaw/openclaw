/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { SelectPicker } from "../../components/select-picker.ts";
import { t } from "../../i18n/index.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createTalkMutationHarness } from "./talk.test-support.tsx";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("reports the chosen speech-to-text provider as not ready and links to Models", async () => {
  const navigate = vi.fn();
  const { page } = createTalkMutationHarness({
    navigate,
    catalogRequest: (_index, catalog) => ({
      ...catalog,
      transcription: {
        ready: true,
        activeProvider: "openai",
        providers: [
          { id: "openai", label: "OpenAI", configured: true },
          { id: "openrouter", label: "OpenRouter", configured: false },
        ],
      },
    }),
  });
  page.configObject = {
    ...page.configObject,
    tools: {
      media: {
        models: [
          { provider: "openai", model: "gpt-4o-transcribe", capabilities: ["audio"] },
          {
            provider: "openrouter",
            model: "openai/whisper-large-v3-turbo",
            capabilities: ["audio"],
          },
        ],
        audio: { preferredModel: "openrouter/openai/whisper-large-v3-turbo" },
      },
    },
  };
  await waitForSolid(() =>
    expect(page.textContent).toContain(
      t("talkPage.transcription.providerNotReadyDescription", { provider: "OpenRouter" }),
    ),
  );
  const open = [...page.querySelectorAll("button")].find(
    (button) => button.textContent === t("talkPage.transcription.openModels"),
  );
  open!.click();
  expect(navigate).toHaveBeenCalledWith("model-providers", { search: "?provider=openrouter" });
});

it("keeps Talk speech-to-text status on the active route when the preferred model is not ready", async () => {
  const { page } = createTalkMutationHarness({
    navigate: vi.fn(),
    catalogRequest: (_index, catalog) => ({
      ...catalog,
      transcription: {
        ready: true,
        activeProvider: "openai",
        providers: [
          { id: "openai", label: "OpenAI", configured: true },
          { id: "openrouter", label: "OpenRouter", configured: false },
        ],
      },
    }),
  });
  page.configObject = {
    ...page.configObject,
    tools: {
      media: {
        models: [
          { provider: "openai", model: "gpt-4o-transcribe", capabilities: ["audio"] },
          {
            provider: "openrouter",
            model: "openai/whisper-large-v3-turbo",
            capabilities: ["audio"],
          },
        ],
        audio: { preferredModel: "openrouter/openai/whisper-large-v3-turbo" },
      },
    },
  };
  const statusRow = () =>
    [...page.querySelectorAll<HTMLElement>("section.settings-section")]
      .find((section) => section.textContent?.includes(t("talkPage.transcription.title")))
      ?.querySelector<HTMLElement>(".settings-row");
  await waitForSolid(() =>
    expect(statusRow()?.textContent).toContain(
      t("talkPage.status.activeProvider", { provider: "openai" }),
    ),
  );
  expect(statusRow()?.textContent).toContain(t("talkPage.status.ready"));
  expect(page.textContent).toContain(
    t("talkPage.transcription.providerNotReadyDescription", { provider: "OpenRouter" }),
  );
});

it("does not call an unavailable speech-to-text provider a missing key", async () => {
  const { page } = createTalkMutationHarness({
    navigate: vi.fn(),
    catalogRequest: (_index, catalog) => ({
      ...catalog,
      transcription: {
        ready: false,
        providers: [{ id: "anthropic", label: "Anthropic", configured: false }],
      },
    }),
  });
  page.configObject = {
    ...page.configObject,
    tools: {
      media: {
        models: [{ provider: "anthropic", model: "claude-opus-5-5", capabilities: ["audio"] }],
        audio: { preferredModel: "anthropic/claude-opus-5-5" },
      },
    },
  };
  await waitForSolid(() =>
    expect(page.textContent).toContain(
      t("talkPage.transcription.providerNotReadyDescription", { provider: "Anthropic" }),
    ),
  );
  expect(page.textContent).not.toContain("No Anthropic key");
});

it("rejects a malformed custom speech-to-text model without changing the preference", async () => {
  const { page, runtimeConfig } = createTalkMutationHarness();
  const picker = await waitForSolid(() => {
    const found = [...page.querySelectorAll<SelectPicker>("openclaw-select-picker")].find(
      (candidate) => candidate.params.label === t("talkPage.transcription.modelTitle"),
    );
    expect(found).toBeDefined();
    return found!;
  });
  picker.params.onChange("openrouter/");
  flush();
  const audioWrites = () =>
    runtimeConfig.patchForm.mock.calls.filter(([path]) => path[0] === "tools");
  expect(audioWrites()).toEqual([]);
  expect(page.textContent).toContain(
    t("talkPage.transcription.invalidModel", { value: "openrouter/" }),
  );

  picker.params.onChange("openrouter/openai/whisper-large-v3-turbo");
  flush();
  expect(audioWrites().map(([path]) => path.join("."))).toEqual([
    "tools.media.models.0",
    "tools.media.audio.preferredModel",
  ]);
  expect(page.textContent).not.toContain(
    t("talkPage.transcription.invalidModel", { value: "openrouter/" }),
  );
});

it("does not report a ready provider-less transcription route as unconfigured", async () => {
  const { page } = createTalkMutationHarness({
    catalogRequest: (_index, catalog) => ({
      ...catalog,
      transcription: { ready: true, providers: [] },
    }),
  });
  page.configObject = {
    ...page.configObject,
    tools: {
      media: {
        models: [
          {
            type: "cli",
            command: "whisper",
            args: ["{{AttachmentPath}}"],
            capabilities: ["audio"],
          },
        ],
      },
    },
  };
  const statusRow = () =>
    [...page.querySelectorAll<HTMLElement>("section.settings-section")]
      .find((section) => section.textContent?.includes(t("talkPage.transcription.title")))
      ?.querySelector<HTMLElement>(".settings-row");
  await waitForSolid(() => expect(statusRow()?.textContent).toContain(t("talkPage.status.ready")));
  expect(statusRow()?.textContent).not.toContain(t("talkPage.transcription.noProvider"));
  expect(statusRow()?.textContent).toContain(t("talkPage.transcription.readyWithoutProvider"));
});
