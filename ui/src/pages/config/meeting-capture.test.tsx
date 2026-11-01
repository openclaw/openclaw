import type { TranscriptsStatusResult } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { meetingStatus } from "../../test-helpers/transcripts.test-support.ts";
import { MeetingCaptureSettings } from "./meeting-capture.tsx";
import {
  clickSettings as click,
  mountConfigSettings,
  settingsButton,
  waitSettingsText as waitText,
} from "./settings-page.test-support.ts";

const requiredProviders: TranscriptsStatusResult["providers"] = meetingStatus.providers.map(
  (provider) => ({
    ...provider,
    autoStart: {
      accountId: "required",
      guildId: "required",
      channelId: "required",
      meetingUrl: "required",
    },
  }),
);
function sourceProvider(
  providerId: string,
  overrides: Partial<TranscriptsStatusResult["providers"][number]> = {},
): TranscriptsStatusResult["providers"][number] {
  return { providerId, name: providerId, availability: "enabled", ...overrides };
}

async function mount(
  options: {
    source?: Record<string, unknown>;
    disabled?: boolean;
    failStatus?: boolean;
    providers?: TranscriptsStatusResult["providers"];
    startDiagnostic?: TranscriptsStatusResult["configuredSources"][number]["startDiagnostic"];
  } = {},
) {
  const original = options.source ?? {
    providerId: "test-voice",
    accountId: "team",
    guildId: "guild",
    channelId: "room",
    meetingUrl: "https://example.test/meeting",
    title: "Original title",
    sessionId: "custom-session",
  };
  const config = {
    transcripts: { enabled: true, autoStart: [original] },
    messages: { ackReaction: "ok" },
  };
  const respond = async (method: string, _params?: { raw?: string; baseHash?: string }) => {
    if (method === "transcripts.status") {
      if (options.failStatus) {
        throw new Error("Archive unavailable");
      }
      const status: TranscriptsStatusResult = {
        ...meetingStatus,
        providers: options.providers ?? meetingStatus.providers,
        configuredSources: meetingStatus.configuredSources.map((source) => ({
          ...source,
          startDiagnostic: options.startDiagnostic,
        })),
      };
      return status;
    }
    if (method === "config.get") {
      return {
        config,
        hash: "one",
        appliedConfigHash: "one",
        valid: true,
        issues: [],
        raw: JSON.stringify(config),
      };
    }
    if (method === "config.set") {
      return { config: JSON.parse((_params as { raw: string }).raw), hash: "two" };
    }
    return {};
  };
  const request = vi.fn(respond);
  const mounted = await mountConfigSettings({ request } as unknown as GatewayBrowserClient, () => (
    <MeetingCaptureSettings mutationDisabled={options.disabled ?? false} />
  ));
  const { page } = mounted;
  await waitForSolid(() =>
    expect(page.textContent).toContain(
      options.failStatus ? "Capture health is unknown" : "Not active",
    ),
  );
  return { ...mounted, request, respond, original };
}

function inputControl(page: Element, name: string) {
  return page.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
}
function providerSelect(page: Element) {
  return page.querySelector<HTMLSelectElement>('select[name="providerId"]')!;
}
function chooseProvider(page: Element, value: string) {
  const select = providerSelect(page);
  select.value = value;
  select.dispatchEvent(new Event("change"));
  flush();
  return select;
}
function submit(page: Element, bubbles = false) {
  page.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles, cancelable: true }));
}
async function expectSaved(
  runtimeConfig: RuntimeConfigCapability,
  request: Awaited<ReturnType<typeof mount>>["request"],
  sources: Record<string, unknown>[],
) {
  await runtimeConfig.save();
  const write = request.mock.calls.find(([method]) => method === "config.set")?.[1];
  expect(write?.baseHash).toBe("one");
  expect(JSON.parse(write!.raw!).transcripts.autoStart).toEqual(sources);
}

function expectSources(runtimeConfig: RuntimeConfigCapability, sources: unknown[]) {
  expect(runtimeConfig.state.configForm?.transcripts).toEqual({
    enabled: true,
    autoStart: sources,
  });
}
async function beginRefresh(page: Element, request: Awaited<ReturnType<typeof mount>>["request"]) {
  const pending = createDeferred<TranscriptsStatusResult>();
  request.mockImplementationOnce(() => pending.promise);
  const refresh = click(page, "Refresh");
  await waitForSolid(() => expect(refresh.disabled).toBe(true));
  return { pending, refresh };
}
function input(page: Element, name: string, value: string) {
  const control = inputControl(page, name);
  control.value = value;
  control.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

describe("curated meeting capture", () => {
  it("retains source controls and health rows through refresh snapshots", async () => {
    const { page, request } = await mount();
    const sourceEdit = settingsButton(page, "Edit source 1");
    const sourceRow = sourceEdit.closest(".settings-row");
    const healthRow = [...page.querySelectorAll(".settings-row")].find((row) =>
      row.querySelector(".settings-status")?.textContent?.includes("Not active"),
    )!;
    const { pending } = await beginRefresh(page, request);
    expect(page.contains(sourceRow)).toBe(true);
    expect(page.contains(healthRow)).toBe(true);
    expect(page.querySelector('button[aria-label="Edit source 1"]')).toBe(sourceEdit);

    const updated = structuredClone<TranscriptsStatusResult>(meetingStatus);
    updated.configuredSources[0]!.state = "armed";
    pending.resolve(updated);
    await waitForSolid(() => expect(healthRow.textContent).toContain("Armed"));
    expect(page.contains(healthRow)).toBe(true);
    expect(page.querySelector('button[aria-label="Edit source 1"]')).toBe(sourceEdit);
  });

  it.each([false, true])(
    "shows unknown health after disconnect (failed read=%s)",
    async (failStatus) => {
      const { page, context, publish } = await mount({ failStatus });
      publish(false, context.gateway.snapshot.client!, null);
      await waitForSolid(() => {
        expect(page.querySelector('[role="alert"]')).toBeNull();
        expect(page.textContent).not.toContain("Archive unavailable");
        expect(page.textContent).not.toContain("No saved transcript was reported.");
        expect(page.querySelectorAll(".settings-status")[0]?.textContent).toContain("Unknown");
      });
    },
  );

  it.each([
    ["pending", "guildId", "", false, false],
    ["missing provider", "accountId", "", false, false],
    ["empty setup", "guildId", "   ", false, false],
    ["pending", "channelId", "", true, false],
    ["error", "accountId", "   ", false, true],
  ] as const)(
    "retains %s validation for %s through health refresh",
    async (health, field, value, openDuringRefresh, reselect) => {
      const { page, runtimeConfig, request } = await mount({
        providers: requiredProviders,
      });
      const pending = createDeferred<TranscriptsStatusResult>();
      request.mockImplementationOnce(() => pending.promise);
      if (!openDuringRefresh) {
        click(page, "Edit source 1");
        input(page, "title", "Not yet submitted");
      }
      const refresh = click(page, "Refresh");
      await waitForSolid(() => expect(refresh.disabled).toBe(true));
      if (openDuringRefresh) {
        click(page, "Edit source 1");
        input(page, "title", "Not yet submitted");
      }
      const control = inputControl(page, field);
      try {
        if (health === "error") {
          pending.reject(new Error("Archive unavailable"));
        } else if (health !== "pending") {
          pending.resolve({
            ...meetingStatus,
            providers:
              health === "missing provider"
                ? []
                : meetingStatus.providers.map((provider) => ({
                    ...provider,
                    autoStart: {},
                  })),
          });
        }
        if (health !== "pending") {
          await waitForSolid(() => expect(refresh.disabled).toBe(false));
        }
        expect(inputControl(page, "title").value).toBe("Not yet submitted");
        if (reselect) {
          page.querySelector('select[name="providerId"]')!.dispatchEvent(new Event("change"));
          flush();
        }
        input(page, field, value);
        click(page, "Save source");
        expect(runtimeConfig.state.configFormDirty).toBe(false);
        expect(page.querySelector(`input[name="${field}"]`)).toBe(control);
        expect(control.required).toBe(true);
      } finally {
        pending.resolve(meetingStatus);
      }
    },
  );

  it.each(["client", "epoch"])(
    "does not seed an editor from another %s's retained health",
    async (change) => {
      const { page, runtimeConfig, request, respond, publish, original } = await mount({
        providers: requiredProviders,
      });
      const { pending: previous, refresh } = await beginRefresh(page, request);
      const current = createDeferred<TranscriptsStatusResult>();
      const currentRequest = vi.fn(
        (method: string, params?: { raw?: string; baseHash?: string }) =>
          method === "transcripts.status" ? current.promise : respond(method, params),
      );
      if (change === "client") {
        publish(true, { request: currentRequest } as unknown as GatewayBrowserClient);
      } else {
        request.mockImplementation(currentRequest);
        publish(true);
      }
      await waitForSolid(() =>
        expect(currentRequest.mock.calls.some(([method]) => method === "transcripts.status")).toBe(
          true,
        ),
      );
      await waitForSolid(() => expect(settingsButton(page, "Edit source 1").disabled).toBe(false));
      try {
        click(page, "Edit source 1");
        expect([...page.querySelectorAll("input")].some((item) => item.required)).toBe(false);
        input(page, "title", "Keep this draft");
        current.resolve({ ...meetingStatus, providers: [] });
        await waitForSolid(() => expect(refresh.disabled).toBe(false));
        previous.resolve({ ...meetingStatus, providers: requiredProviders });
        await previous.promise;
        flush();
        expect([...page.querySelectorAll("input")].some((item) => item.required)).toBe(false);
        expect(inputControl(page, "title").value).toBe("Keep this draft");
        click(page, "Save source");
        await expectSaved(runtimeConfig, currentRequest, [
          { ...original, title: "Keep this draft" },
        ]);
      } finally {
        current.resolve({ ...meetingStatus, providers: [] });
        previous.resolve(meetingStatus);
      }
    },
  );

  it("retains requirements learned after opening an editor without metadata", async () => {
    const { page, runtimeConfig, request, original } = await mount({
      source: { providerId: "test-voice", title: "Original", providerOptions: { keep: true } },
      providers: [],
    });
    click(page, "Edit source 1");
    expect(page.querySelector('input[name="guildId"]')).toBeNull();
    input(page, "title", "Unsaved title");
    request.mockResolvedValueOnce({ ...meetingStatus, providers: requiredProviders });
    click(page, "Refresh");
    await waitForSolid(() => expect(inputControl(page, "guildId").required).toBe(true));
    request.mockRejectedValueOnce(new Error("Archive unavailable"));
    click(page, "Refresh");
    await waitText(page, "Capture health is unknown");
    const locators = {
      accountId: "team",
      guildId: "guild",
      channelId: "room",
      meetingUrl: "https://example.test/new",
    };
    for (const [field, value] of Object.entries(locators)) {
      input(page, field, value);
    }
    input(page, "channelId", "   ");
    expect(page.querySelector("form")!.checkValidity()).toBe(true);
    click(page, "Edit source 1");
    click(page, "Save source");
    expect(page.querySelector('form [role="alert"]')?.textContent).toContain("Channel ID");
    expect(inputControl(page, "title").value).toBe("Unsaved title");
    input(page, "channelId", locators.channelId);
    click(page, "Save source");
    await expectSaved(runtimeConfig, request, [
      { ...original, ...locators, title: "Unsaved title" },
    ]);
    flush();
    click(page, "Edit source 1");
    expect([...page.querySelectorAll("input")].some((item) => item.required)).toBe(false);
  });

  it.each(["pending", "error"])(
    "preserves original provider validation through %s provider round trips",
    async (health) => {
      const { page, runtimeConfig, request, original } = await mount({
        providers: [...requiredProviders, sourceProvider("other", { autoStart: {} })],
      });
      click(page, "Edit source 1");
      chooseProvider(page, "other");
      expect([...page.querySelectorAll("input")].some((item) => item.required)).toBe(false);
      const { pending } = await beginRefresh(page, request);
      try {
        if (health === "error") {
          pending.reject(new Error("Archive unavailable"));
          await waitText(page, "Capture health is unknown");
        }
        submit(page);
        expectSources(runtimeConfig, [original]);
        chooseProvider(page, "test-voice");
        input(page, "guildId", "   ");
        click(page, "Save source");
        expect(inputControl(page, "guildId").required).toBe(true);
        expect(runtimeConfig.state.configFormDirty).toBe(false);
      } finally {
        pending.resolve(meetingStatus);
      }
    },
  );

  it("explains a session ID conflict without hiding the configured ID or changing the draft", async () => {
    const { page, runtimeConfig, original } = await mount({ startDiagnostic: "id-conflict" });
    expect(page.textContent).toContain("This session ID conflicts with an existing capture");
    click(page, "Edit source 1");
    expect(inputControl(page, "sessionId").value).toBe(original.sessionId);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
  });

  it("disables an occupancy source's ignored custom ID while preserving it through a title edit", async () => {
    const source = {
      providerId: "test-voice",
      title: "Occupied room",
      guildId: "guild",
      channelId: "room",
      whenOccupied: true,
      sessionId: "saved-custom-id",
    };
    const { page, runtimeConfig, request } = await mount({ source });
    click(page, "Edit source 1");
    const id = inputControl(page, "sessionId");
    expect(id.disabled).toBe(true);
    expect(id.value).toBe(source.sessionId);
    expect(page.textContent).toContain("Occupancy mode chooses session IDs automatically");
    input(page, "title", "Future occupied room");
    click(page, "Save source");
    await expectSaved(runtimeConfig, request, [{ ...source, title: "Future occupied room" }]);
  });

  it("does not save another entry's dirty locator when switching directly between equal sources", async () => {
    const { page, runtimeConfig, original } = await mount();
    const second = { ...original, title: "Second source" };
    runtimeConfig.patchForm(["transcripts", "autoStart"], [original, second]);
    flush();
    click(page, "Edit source 1");
    input(page, "accountId", "unsaved-account");
    click(page, "Edit source 2");
    submit(page);
    expectSources(runtimeConfig, [original, second]);
  });

  it("opens the transcript library", async () => {
    const { page, navigate } = await mount();
    click(page, "Transcript library");
    expect(navigate).toHaveBeenCalledWith("meetings");
  });

  it.each([" test-voice ", " unknown "])(
    "preserves %s on re-entry and save",
    async (providerId) => {
      const refresh = !providerId.includes("unknown");
      const source = {
        providerId,
        title: "Original title",
        sessionId: " daily ",
        ...(providerId.includes("unknown")
          ? {}
          : {
              accountId: " team ",
              guildId: " guild ",
              channelId: " room ",
              meetingUrl: " https://example.test/meeting?invitation=synthetic#fragment ",
            }),
        providerOptions: { untouched: true },
      };
      const { page, runtimeConfig, request } = await mount({ source });
      click(page, "Edit source 1");
      const url = page.querySelector<HTMLInputElement>('input[name="meetingUrl"]');
      if (source.meetingUrl) {
        expect(url?.value).toBe(source.meetingUrl.trim());
        expect(new FormData(page.querySelector("form")!).get("meetingUrl")).not.toBe(
          source.meetingUrl,
        );
      } else {
        expect(url).toBeNull();
        expect(page.querySelector('input[name="accountId"]')).toBeNull();
      }
      input(page, "title", " Future title ");
      if (refresh) {
        request.mockResolvedValueOnce({ ...meetingStatus, providers: [] });
        click(page, "Refresh");
        await waitForSolid(() => expect(providerSelect(page).options).toHaveLength(2));
      }
      click(page, "Edit source 1");
      expect(inputControl(page, "title").value).toBe(" Future title ");
      click(page, "Save source");
      expect(source.title).toBe("Original title");
      await expectSaved(runtimeConfig, request, [{ ...source, title: "Future title" }]);
    },
  );

  it("normalizes edited values and explicitly clears optional fields without rewriting untouched values", async () => {
    const source = {
      providerId: "test-voice",
      title: "Original title",
      sessionId: " daily ",
      accountId: " team ",
      guildId: " guild ",
      channelId: " room ",
      meetingUrl: " https://example.test/old?invitation=synthetic ",
    };
    const { page, runtimeConfig } = await mount({ source });
    click(page, "Edit source 1");
    input(page, "accountId", " new-account ");
    input(page, "meetingUrl", " https://example.test/new?invitation=updated ");
    input(page, "sessionId", "");
    input(page, "title", " ");
    click(page, "Edit source 1");
    click(page, "Save source");
    expectSources(runtimeConfig, [
      {
        providerId: "test-voice",
        accountId: "new-account",
        guildId: " guild ",
        channelId: " room ",
        meetingUrl: "https://example.test/new?invitation=updated",
      },
    ]);
  });

  it("requires Cancel and reopen to edit a replaced source, including after re-entry", async () => {
    const { page, runtimeConfig, original, request } = await mount();
    click(page, "Edit source 1");
    input(page, "title", "Stale edit");
    const replacement = { ...original, sessionId: "replacement" };
    runtimeConfig.patchForm(["transcripts", "autoStart"], [replacement]);
    flush();
    submit(page);
    flush();
    expectSources(runtimeConfig, [replacement]);
    const error = "Cancel and reopen it to use the current draft.";
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(error);
    click(page, "Edit source 1");
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(error);
    expect(inputControl(page, "title").value).toBe("Stale edit");
    click(page, "Save source");
    expectSources(runtimeConfig, [replacement]);
    click(page, "Cancel");
    click(page, "Edit source 1");
    expect(inputControl(page, "title").value).toBe(original.title);
    expect(inputControl(page, "sessionId").value).toBe("replacement");
    expect(page.querySelector('[role="alert"]')).toBeNull();
    input(page, "title", "Current edit");
    click(page, "Save source");
    await expectSaved(runtimeConfig, request, [{ ...replacement, title: "Current edit" }]);
  });

  it.each([false, true])(
    "validates a genuine provider change against current metadata (unavailable=%s)",
    async (unavailable) => {
      const { page, runtimeConfig, original, request } = await mount({
        providers: [...meetingStatus.providers, sourceProvider("other", { autoStart: {} })],
      });
      click(page, "Edit source 1");
      const provider = chooseProvider(page, "other");
      if (unavailable) {
        request.mockResolvedValueOnce({ ...meetingStatus, providers: [] });
        click(page, "Refresh");
        await waitForSolid(() =>
          expect([...provider.options].map((option) => option.value)).toEqual([
            "",
            "test-voice",
            "other",
          ]),
        );
        expect(provider.value).toBe("other");
      }
      submit(page);
      expect(runtimeConfig.state.configForm).toMatchObject({
        transcripts: {
          autoStart: [{ ...original, providerId: unavailable ? original.providerId : "other" }],
        },
      });
      expect(runtimeConfig.state.configFormDirty).toBe(!unavailable);
    },
  );

  it("rejects an open editor submission after admin access is revoked", async () => {
    const { page, context, runtimeConfig, original, publish } = await mount();
    click(page, "Edit source 1");
    input(page, "title", "Unauthorized edit");
    const snapshot = context.gateway.snapshot;
    publish(true, snapshot.client!, {
      ...snapshot.hello!,
      auth: { ...snapshot.hello!.auth, scopes: ["operator.read"] },
    });
    flush();
    submit(page);
    expectSources(runtimeConfig, [original]);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
  });

  it("adds a source and removes an entry without removing stored transcripts or sibling config", async () => {
    const { page, runtimeConfig, request } = await mount({
      providers: meetingStatus.providers.map(({ canStart: _canStart, ...provider }) => provider),
    });
    click(page, "Add source");
    chooseProvider(page, "test-voice");
    const guild = inputControl(page, "guildId");
    expect(guild.required).toBe(true);
    expect(inputControl(page, "accountId").required).toBe(false);
    expect(page.querySelector('input[name="meetingUrl"]')).toBeNull();
    expect(page.querySelector("form")!.checkValidity()).toBe(false);
    input(page, "guildId", "   ");
    input(page, "channelId", " second-room ");
    input(page, "accountId", "   ");
    expect(page.querySelector("form")!.checkValidity()).toBe(true);
    click(page, "Save source");
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("Guild ID");
    input(page, "guildId", " second-guild ");
    click(page, "Add source");
    expect(providerSelect(page).value).toBe("test-voice");
    expect(inputControl(page, "guildId").value).toBe(" second-guild ");
    const pending = createDeferred<TranscriptsStatusResult>();
    request.mockImplementationOnce(() => pending.promise);
    const refresh = click(page, "Refresh");
    await waitText(page, "Loading");
    submit(page);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    pending.resolve(meetingStatus);
    await waitForSolid(() => expect(refresh.disabled).toBe(false));
    expect(inputControl(page, "guildId").value).toBe(" second-guild ");
    click(page, "Save source");
    click(page, "Remove source 1");
    expect(runtimeConfig.state.configForm?.messages).toEqual({ ackReaction: "ok" });
    expect(
      request.mock.calls.some(([method]) => method.includes("delete") || method.includes("stop")),
    ).toBe(false);
    await expectSaved(runtimeConfig, request, [
      { providerId: "test-voice", guildId: "second-guild", channelId: "second-room" },
    ]);
    flush();
    click(page, "Add source");
    expect(providerSelect(page).value).toBe("");
    input(page, "title", "Discard this draft");
    click(page, "Cancel");
    click(page, "Add source");
    expect(inputControl(page, "title").value).toBe("");
    expect(page.querySelector('input[name="guildId"]')).toBeNull();
  });

  it("offers enabled manifest setup before runtime loads, but rejects observed start contradictions", async () => {
    const { page } = await mount({
      providers: [
        ...meetingStatus.providers,
        sourceProvider("attach-only", {
          canStart: true,
        }),
        sourceProvider("metadata-only", { autoStart: {} }),
        sourceProvider("disabled", {
          availability: "disabled",
          canStart: true,
          autoStart: {},
        }),
        sourceProvider("cannot-start", { canStart: false, autoStart: {} }),
      ],
    });
    click(page, "Add source");
    expect(
      [...page.querySelectorAll<HTMLOptionElement>('select[name="providerId"] option')].map(
        (option) => option.value,
      ),
    ).toEqual(["", "metadata-only", "test-voice"]);
  });

  it("keeps existing disabled sources editable with unavailable guidance", async () => {
    const { page, runtimeConfig, original } = await mount({
      providers: [{ providerId: "test-voice", name: "Test voice", availability: "disabled" }],
    });
    const add = settingsButton(page, "Add source");
    expect(add.disabled).toBe(true);
    click(page, "Edit source 1");
    expect(page.textContent).toContain("Auto-start setup is unavailable");
    input(page, "title", "Still editable");
    submit(page, true);
    expectSources(runtimeConfig, [{ ...original, title: "Still editable" }]);
  });

  it("keeps health unknown after read failure and disables mutations under the parent's permission gate", async () => {
    const { page, runtimeConfig } = await mount({ disabled: true, failStatus: true });
    expect(page.textContent).toContain("Unknown");
    expect(page.textContent).not.toContain("Not active");
    expect(
      [
        ...page.querySelectorAll<HTMLButtonElement>(
          'button[aria-label^="Edit source"], button[aria-label^="Remove source"]',
        ),
      ].every((button) => button.disabled),
    ).toBe(true);
    expect(page.querySelector('input[role="switch"]')?.hasAttribute("disabled")).toBe(true);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
  });

  it("keeps the draft and Refresh control through a rejected health read and retry", async () => {
    const { page, request, respond } = await mount();
    click(page, "Edit source 1");
    input(page, "title", "Unsaved meeting title");
    const title = inputControl(page, "title");
    const failure = createDeferred<TranscriptsStatusResult>();
    request.mockImplementationOnce(() => failure.promise);
    const refresh = settingsButton(page, "Refresh");
    title.focus();
    click(page, "Refresh");
    failure.reject(new Error("Health read unavailable"));
    await waitText(page, "Health read unavailable");
    expect(title.value).toBe("Unsaved meeting title");
    expect(refresh.isConnected).toBe(true);
    expect(document.activeElement).toBe(title);

    request.mockImplementation(respond);
    expect(click(page, "Refresh")).toBe(refresh);
    await waitText(page, "Not active");
    expect(page.textContent).not.toContain("Health read unavailable");
    expect(page.querySelector('input[name="title"]')).toBe(title);
    expect(title.value).toBe("Unsaved meeting title");
  });

  it("does not overwrite an authoritative raw config draft with an old source array", async () => {
    const { page, runtimeConfig } = await mount();
    click(page, "Edit source 1");
    input(page, "title", "Stale title");
    runtimeConfig.setRaw('{ "transcripts": { "autoStart": [{ "providerId": "other" }] } }');
    flush();
    expect(page.textContent).toContain("Save or discard the pending raw config draft");
    expect(settingsButton(page, "Remove source 1").disabled).toBe(true);
    submit(page);
    expect(runtimeConfig.state.configRaw).toContain('"providerId": "other"');
  });
});
