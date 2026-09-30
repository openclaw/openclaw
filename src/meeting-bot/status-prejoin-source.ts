import { MEETING_AUDIO_BRIDGE_SOURCE } from "./audio-bridge-source.js";

type MeetingStatusPreludeParams = {
  allowMicrophone: boolean;
  allowSessionAdoption: boolean;
  autoJoin: boolean;
  captureCaptions: boolean;
  expectedIdentity?: string;
  guestName: string;
  meetingSessionId?: string;
  pageIdentitySource: string;
  readOnly?: boolean;
  selectors: string;
  toggleStateFunction: string;
  waitForInCallMs: number;
};

type MeetingStatusPreludeSourceOptions = {
  controlLookupSource: string;
  lifecycleSource: string;
  manualActionSource: string;
  platform: {
    displayName: string;
    globals: {
      audioOutputs: string;
      captionArchive: string;
      captions: string;
      meeting: string;
    };
    manualActionReasonPrefix: string;
  };
  setupSource?: string;
  transcriptMaxLines?: number;
};

export function createMeetingStatusPreludeSource(
  params: MeetingStatusPreludeParams,
  options: MeetingStatusPreludeSourceOptions,
): string {
  const audioOutputsGlobal = JSON.stringify(options.platform.globals.audioOutputs);
  const captionArchiveGlobal = JSON.stringify(options.platform.globals.captionArchive);
  const captionsGlobal = JSON.stringify(options.platform.globals.captions);
  const meetingGlobal = JSON.stringify(options.platform.globals.meeting);
  const transcriptMaxLines = options.transcriptMaxLines ?? 500;
  return `async () => {
  ${params.pageIdentitySource}
  ${options.setupSource ?? ""}
  const parseToggleState = ${params.toggleStateFunction};
  const selectors = ${params.selectors};
  const expectedIdentity = ${JSON.stringify(params.expectedIdentity)};
  const allowMicrophone = ${JSON.stringify(params.allowMicrophone)};
  const allowSessionAdoption = ${JSON.stringify(params.allowSessionAdoption)};
  const autoJoin = ${JSON.stringify(params.autoJoin)};
  const captureCaptions = ${JSON.stringify(params.captureCaptions)};
  const readOnly = ${JSON.stringify(Boolean(params.readOnly))};
  const sessionId = ${JSON.stringify(params.meetingSessionId)};
  const identityRetentionMs = ${JSON.stringify(Math.max(30_000, params.waitForInCallMs))};
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  const label = (node) => [
    node?.getAttribute?.("aria-label"),
    node?.getAttribute?.("title"),
    node?.getAttribute?.("data-tid"),
    text(node),
  ].filter(Boolean).join(" ");
  const manualActionFor = (reason, message) => ({ reason, message });
  const clickable = (node) => node?.matches?.("button")
    ? node
    : node?.querySelector?.("button") || node?.closest?.("button") || node;
  const first = (list) => clickable(firstRaw(list));
  const firstRaw = (list) => {
    for (const selector of list) {
      const node = document.querySelector(selector);
      if (node) return node;
    }
    return undefined;
  };
  const firstWithin = (root, list) => {
    if (!root) return undefined;
    for (const selector of list) {
      if (root.matches?.(selector)) return root;
      const node = root.querySelector?.(selector);
      if (node) return node;
    }
    return undefined;
  };
  // Keep these names scoped: older plugin lifecycle fragments declare their own helpers.
  const meetingAudioInput = (() => {
    const isVirtualAudioDevice = (value) =>
      /^(?:blackhole 2ch(?: \\(virtual\\))?|openclaw meeting audio)$/i.test(
        String(value || "").replace(/\\s+/g, " ").trim()
      );
    const isVirtualAudioDeviceNode = (node) => [
      node?.getAttribute?.("aria-label"),
      node?.getAttribute?.("title"),
      node?.label,
      node?.value,
      text(node),
    ].some(isVirtualAudioDevice);
    const microphoneDeviceRoots = () => {
      // Consumer in-call controls expose the listbox itself, without the prejoin
      // selected-device button/combobox wrapper.
      const control = firstRaw(selectors.microphoneDevice) || firstRaw(selectors.microphoneDeviceMenu);
      if (!control) return { control, roots: [] };
      const roots = [control];
      const scope = control.closest?.(selectors.microphoneDeviceScope);
      if (scope && !roots.includes(scope)) roots.push(scope);
      const listboxId = control.getAttribute?.("aria-controls");
      const listbox = listboxId ? document.getElementById?.(listboxId) : undefined;
      if (listbox && !roots.includes(listbox)) roots.push(listbox);
      const liveMenu = firstRaw(selectors.microphoneDeviceMenu);
      if (liveMenu && !roots.includes(liveMenu)) roots.push(liveMenu);
      return { control, roots };
    };
    const selectedMicrophoneLabel = () => {
      const { control, roots } = microphoneDeviceRoots();
      const selectedOption = control?.selectedOptions?.[0];
      if (selectedOption && isVirtualAudioDeviceNode(selectedOption)) {
        return label(selectedOption) || selectedOption.value;
      }
      if (control && isVirtualAudioDeviceNode(control)) return label(control) || control.value;
      for (const root of roots) {
        const selected = firstWithin(root, selectors.selectedMicrophoneDevice);
        if (selected && isVirtualAudioDeviceNode(selected)) {
          return label(selected) || selected.value;
        }
      }
      return undefined;
    };
    return { isVirtualAudioDevice, isVirtualAudioDeviceNode, microphoneDeviceRoots, selectedMicrophoneLabel };
  })();
  ${options.controlLookupSource}
  const waitForUi = () => new Promise((resolve) => setTimeout(resolve, 120));
  const bridgeOwnedBySession = (entry) => Boolean(
    sessionId && (!entry?.sessionId || entry.sessionId === sessionId)
  );
  ${MEETING_AUDIO_BRIDGE_SOURCE}
  const retireOwnedAudioBridges = (restoreSources = true) => {
    const entries = Array.isArray(window[${audioOutputsGlobal}])
      ? window[${audioOutputsGlobal}]
      : [];
    const retained = [];
    for (const entry of entries) {
      if (!bridgeOwnedBySession(entry)) {
        retained.push(entry);
        continue;
      }
      retireAudioBridge(entry, restoreSources);
    }
    if (retained.length > 0) window[${audioOutputsGlobal}] = retained;
    else delete window[${audioOutputsGlobal}];
  };
  const suspendOwnedAudioBridges = (adopt = false) => {
    const entries = Array.isArray(window[${audioOutputsGlobal}])
      ? window[${audioOutputsGlobal}]
      : [];
    const retained = [];
    const suspendedBySource = new Map();
    for (const entry of entries) {
      if (!adopt && !bridgeOwnedBySession(entry)) {
        retained.push(entry);
        continue;
      }
      // This pending entry owns the muted element until a later serialized
      // status poll sees and routes the attached playback source.
      if (
        !adopt &&
        entry?.pending &&
        bridgeSources(entry).some((source) => bridgeSourceMatches(source?.element, source))
      ) {
        retained.push(entry);
        continue;
      }
      for (const source of bridgeSources(entry)) {
        if (!source?.element || suspendedBySource.has(source.element)) continue;
        if (!bridgeSourceMatches(source.element, source)) {
          restoreAudioBridgeSource(source);
          continue;
        }
        suspendedBySource.set(source.element, {
          sessionId: adopt ? sessionId : entry.sessionId || sessionId,
          source: source.element,
          sourceMuted: Boolean(source.muted),
          sourceUrl: adopt ? mediaSourceUrl(source.element) || source.url : source.url,
          stream: source.element.srcObject,
          suspended: true,
        });
      }
      retireAudioBridge(entry, false);
    }
    const next = [...retained, ...suspendedBySource.values()];
    if (next.length > 0) window[${audioOutputsGlobal}] = next;
    else delete window[${audioOutputsGlobal}];
  };
  const adoptAudioBridgeSourcesForSession = () => suspendOwnedAudioBridges(true);
  const retireOwnedCaptions = () => {
    const active = window[${captionsGlobal}];
    const owned = Boolean(
      active && sessionId && (!active.sessionId || active.sessionId === sessionId)
    );
    if (!owned) return;
    if (active.settleTimer !== undefined) clearTimeout(active.settleTimer);
    active.observer?.disconnect?.();
    delete window[${captionsGlobal}];
  };
  const finalizeCaptionState = (active) => {
    if (!active) return;
    if (active.settleTimer !== undefined) clearTimeout(active.settleTimer);
    active.settleTimer = undefined;
    active.observer?.disconnect?.();
    active.observer = undefined;
    active.observerInstalled = false;
    active.lines = Array.isArray(active.lines) ? active.lines : [];
    if (Array.isArray(active.visible) && active.visible.length > 0) {
      active.lines.push(...active.visible.map((entry) => ({
        at: entry.at,
        speaker: entry.speaker,
        text: entry.text,
      })));
      active.visible = [];
    }
    const excess = active.lines.length - ${transcriptMaxLines};
    if (excess > 0) {
      active.lines.splice(0, excess);
      active.droppedLines = (active.droppedLines || 0) + excess;
    }
    active.finalized = true;
    active.finalizedAt = Date.now();
  };
  const archiveFinalizedCaptions = (active) => {
    if (active?.finalized !== true || !active.sessionId) return;
    const archive = window[${captionArchiveGlobal}] &&
        typeof window[${captionArchiveGlobal}] === "object"
      ? window[${captionArchiveGlobal}]
      : {};
    archive[active.sessionId] = active;
    const retained = Object.entries(archive)
      .sort((left, right) => Number(right[1]?.finalizedAt || 0) - Number(left[1]?.finalizedAt || 0))
      .slice(0, 4);
    window[${captionArchiveGlobal}] = Object.fromEntries(retained);
  };
  const finalizeOwnedCaptions = () => {
    const active = window[${captionsGlobal}];
    const owned = Boolean(
      active && sessionId && (!active.sessionId || active.sessionId === sessionId)
    );
    if (owned) {
      active.identity ||= priorMeeting?.identity || expectedIdentity;
      finalizeCaptionState(active);
    }
  };
  const toggleState = (node, kind) => parseToggleState({
    kind,
    ariaPressed: node?.getAttribute?.("aria-pressed"),
    ariaChecked: node?.getAttribute?.("aria-checked"),
    checked: typeof node?.checked === "boolean" ? node.checked : undefined,
    iconClass: node?.querySelector?.("svg")?.getAttribute?.("class"),
    label: label(node),
  });
  const notes = [];
  const currentIdentity = meetingIdentity(location.href);
  const priorMeeting = window[${meetingGlobal}];
  if (expectedIdentity && currentIdentity && currentIdentity !== expectedIdentity) {
    // A confirmed SPA transition must stop resources still owned by this
    // request, while preserving any newer session already committed to the tab.
    retireOwnedAudioBridges();
    finalizeOwnedCaptions();
    const requestOwnsMeeting = Boolean(
      priorMeeting &&
      sessionId &&
      (!priorMeeting.sessionId || priorMeeting.sessionId === sessionId)
    );
    if (requestOwnsMeeting) delete window[${meetingGlobal}];
    return JSON.stringify({
      inCall: false,
      manualAction: manualActionFor("${options.platform.manualActionReasonPrefix}-session-conflict", "The tracked ${options.platform.displayName} tab now shows a different meeting. Return to the requested meeting link, then retry."),
      title: document.title,
      url: location.href,
      notes,
    });
  }
  const meetingOwnerConflict = Boolean(
    priorMeeting?.sessionId && priorMeeting.sessionId !== sessionId
  );
  const captionOwnerConflict = Boolean(
    window[${captionsGlobal}]?.sessionId &&
    window[${captionsGlobal}].sessionId !== sessionId
  );
  const committedOwnerConflict = meetingOwnerConflict || captionOwnerConflict;
  const canRepairCaptionOwner = Boolean(
    !meetingOwnerConflict && priorMeeting?.sessionId === sessionId
  );
  const canMutateSession = Boolean(
    !readOnly &&
    sessionId &&
    (!committedOwnerConflict || canRepairCaptionOwner || allowSessionAdoption)
  );
  const identityMatchedUrl = Boolean(expectedIdentity && currentIdentity === expectedIdentity);
  const identityVerifiedBeforeCall = identityMatchedUrl;
  const previousRemoteCapture = window.__openclawMeetingRemoteAudio;
  if (canMutateSession && allowSessionAdoption && previousRemoteCapture && previousRemoteCapture.sessionId !== sessionId) {
    await previousRemoteCapture.stop();
  }
  ${options.lifecycleSource}
  const micMuted = microphoneState === "off" ? true : microphoneState === "on" ? false : undefined;
  const cameraOff = cameraState === "off" ? true : cameraState === "on" ? false : undefined;
  ${options.manualActionSource}
`;
}
