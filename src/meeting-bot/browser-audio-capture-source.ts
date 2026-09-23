export type MeetingBrowserAudioCaptureRequest = {
  action: "start" | "pull" | "stop";
  captureId: string;
  meetingSessionId: string;
  meetingUrl: string;
};

/** Captures browser playback before the native virtual microphone bus. */
export function createMeetingBrowserAudioCaptureSource(
  params: MeetingBrowserAudioCaptureRequest & {
    ownershipSource: string;
    audioOutputsGlobal?: string;
  },
): string {
  return `async () => {
  const action = ${JSON.stringify(params.action)};
  const captureId = ${JSON.stringify(params.captureId)};
  const sessionId = ${JSON.stringify(params.meetingSessionId)};
  const ownsSession = () => { ${params.ownershipSource} };
  const current = window.__openclawMeetingRemoteAudio;
  if (action === "stop") {
    if (current?.captureId === captureId) await current.stop();
    return JSON.stringify({ closed: true, captureId });
  }
  if (action === "pull") {
    if (!current || current.captureId !== captureId || !current.isCurrent()) {
      if (current?.captureId === captureId) await current.stop();
      return JSON.stringify({ closed: true, captureId });
    }
    current.lastPull = Date.now();
    current.scan();
    if (current.error) throw new Error(current.error);
    const chunks = current.chunks.splice(0);
    let binary = "";
    for (const chunk of chunks) for (const byte of chunk) binary += String.fromCharCode(byte);
    return JSON.stringify({ captureId, isolated: true, base64: btoa(binary) });
  }
  if (!ownsSession()) throw new Error("Meeting audio capture no longer owns this browser session.");
  if (current) throw new Error("Meeting browser audio capture is already active.");
  const context = new AudioContext({ sampleRate: 24000 });
  const entries = new Map();
  const pendingMute = new Map();
  const sourceNodes = new Map();
  const mutedBridges = new Map();
  const chunks = [];
  let observer;
  let timer;
  let processor;
  let stopped = false;
  let deviceRefresh;
  let inputDevices = new Set(["default", "communications"]);
  let inputGroups = new Set();
  const sourceUrl = (element) => String(element.currentSrc || element.src || "");
  const ownsMutedSource = (entry, liveTracks) => entry.stream
    ? entry.element.srcObject === entry.stream &&
      (liveTracks ?? entry.stream.getAudioTracks().filter((track) => track.readyState === "live"))
        .every((track) => entry.tracks.includes(track))
    : !entry.element.srcObject && sourceUrl(entry.element) === entry.url;
  const sameSource = (entry) => {
    const liveTracks = entry.stream && entry.element.srcObject === entry.stream
      ? entry.stream.getAudioTracks().filter((track) => track.readyState === "live")
      : undefined;
    return ownsMutedSource(entry, liveTracks) && (!entry.stream || (
      liveTracks.length === entry.tracks.length &&
      entry.tracks.every((track) => track.readyState === "live")
    ));
  };
  const restoreOwnedMute = (entry, restore = capture.isCurrent()) => {
    if (restore && ownsMutedSource(entry)) entry.element.muted = entry.muted;
  };
  const capture = {
    captureId, sessionId, chunks, lastPull: Date.now(), error: undefined,
    isCurrent: () => !stopped && window.__openclawMeetingRemoteAudio === capture && ownsSession(),
    stop: async () => {
      if (stopped) return;
      const restore = capture.isCurrent();
      stopped = true;
      clearInterval(timer);
      observer?.disconnect();
      document.removeEventListener("play", scan, true);
      document.removeEventListener("loadedmetadata", scan, true);
      window.removeEventListener("pagehide", onPageHide);
      navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
      for (const entry of entries.values()) {
        if (entry.captured) entry.captured.getTracks().forEach((track) => track.stop());
        restoreOwnedMute(entry, restore);
      }
      for (const entry of pendingMute.values()) {
        restoreOwnedMute(entry, restore);
      }
      for (const entry of mutedBridges.values()) {
        restoreOwnedMute(entry, restore);
      }
      entries.clear();
      pendingMute.clear();
      for (const node of sourceNodes.values()) node.disconnect();
      sourceNodes.clear();
      mutedBridges.clear();
      chunks.length = 0;
      processor?.disconnect();
      if (window.__openclawMeetingRemoteAudio === capture) delete window.__openclawMeetingRemoteAudio;
      await context.close();
    },
    scan: () => scan(),
  };
  const onPageHide = () => { void capture.stop(); };
  const ownedOutputEntries = () => {
    const all = ${params.audioOutputsGlobal ? `window[${JSON.stringify(params.audioOutputsGlobal)}]` : "undefined"};
    return Array.isArray(all) ? all.filter((entry) => entry?.sessionId === sessionId) : [];
  };
  const outputSources = (entry) => Array.isArray(entry.sources) ? entry.sources : entry.source
    ? [{ element: entry.source, muted: Boolean(entry.sourceMuted), stream: entry.stream }]
    : [];
  const hasDeviceTrack = (tracks) => tracks.some((track) => {
    const settings = track.getSettings();
    // Chromium receiver tracks also have deviceId (equal to the track id).
    // Only device identities actually enumerated as inputs identify microphone audio.
    return Boolean(inputDevices.has(settings.deviceId) || inputGroups.has(settings.groupId));
  });
  const refreshDevices = () => {
    deviceRefresh ??= (async () => {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!capture.isCurrent()) throw new Error("Meeting changed while audio devices were being inspected.");
      const inputs = devices.filter((device) => device.kind === "audioinput");
      inputDevices = new Set(["default", "communications", ...inputs.map((device) => device.deviceId).filter(Boolean)]);
      inputGroups = new Set(inputs.map((device) => device.groupId).filter(Boolean));
    })().finally(() => { deviceRefresh = undefined; });
    return deviceRefresh;
  };
  const onDeviceChange = () => {
    chunks.length = 0;
    void refreshDevices().then(scan).catch((error) => {
      capture.error = error?.message || String(error);
      void capture.stop();
    });
  };
  function scan() {
    if (!capture.isCurrent() || Date.now() - capture.lastPull > 10000) {
      void capture.stop();
      return;
    }
    if (deviceRefresh) return;
    try {
      const bridges = ownedOutputEntries();
      const bridgeElements = new Set(bridges.map((entry) => entry.bridge).filter(Boolean));
      for (const [bridge, entry] of mutedBridges) {
        if (!bridgeElements.has(bridge) || !ownsMutedSource(entry)) {
          restoreOwnedMute(entry);
          mutedBridges.delete(bridge);
        }
      }
      const ownedSources = new Map(bridges.flatMap((entry) => outputSources(entry).map((source) => [source.element, source])));
      const elements = new Set(document.querySelectorAll("audio, video"));
      for (const [element, entry] of pendingMute) {
        if (!elements.has(element)) {
          restoreOwnedMute(entry);
          pendingMute.delete(element);
        }
      }
      for (const [element, entry] of entries) {
        if (!elements.has(element) || !sameSource(entry) || hasDeviceTrack(entry.tracks)) {
          chunks.length = 0;
          if (entry.captured) entry.captured.getTracks().forEach((track) => track.stop());
          // Retain the source and track identities when input goes idle so stop
          // can undo our mute without touching replacement media on this element.
          if (elements.has(element)) pendingMute.set(element, entry);
          else restoreOwnedMute(entry);
          entries.delete(element);
        }
      }
      for (const entry of entries.values()) {
        entry.element.muted = true;
      }
      for (const element of elements) {
        if (bridgeElements.has(element) || entries.has(element)) continue;
        const owned = ownedSources.get(element);
        const pending = pendingMute.get(element);
        const originalMute = pending ? pending.muted
          : owned && owned.stream === element.srcObject ? owned.muted : element.muted;
        if (originalMute) continue;
        const stream = element.srcObject;
        const tracks = stream?.getAudioTracks?.().filter((track) => track.readyState === "live") || [];
        // Device-backed tracks include the virtual microphone and must never enter provider input.
        if (hasDeviceTrack(tracks)) {
          if (pending) restoreOwnedMute(pending);
          pendingMute.delete(element);
          continue;
        }
        if (stream && !tracks.length) continue;
        if (!stream && (!sourceUrl(element) || element.readyState < 2)) continue;
        if (entries.size + pendingMute.size >= 64 && !pending) throw new Error("Meeting remote audio source limit exceeded.");
        const captured = stream ? undefined : element.captureStream();
        const audioTracks = stream ? tracks : captured.getAudioTracks();
        if (!audioTracks.length || hasDeviceTrack(audioTracks)) {
          captured?.getTracks().forEach((track) => track.stop());
          continue;
        }
        entries.set(element, { element, stream, url: sourceUrl(element), muted: Boolean(originalMute), captured, tracks: audioTracks });
        pendingMute.delete(element);
        element.muted = true;
      }
      const tracks = new Set([...entries.values()].flatMap((entry) => entry.tracks));
      if (tracks.size > 64) throw new Error("Meeting remote audio track limit exceeded.");
      for (const [track, node] of sourceNodes) {
        if (!tracks.has(track)) { node.disconnect(); sourceNodes.delete(track); }
      }
      for (const track of tracks) {
        if (sourceNodes.has(track)) continue;
        const node = context.createMediaStreamSource(new MediaStream([track]));
        node.connect(processor);
        sourceNodes.set(track, node);
      }
      for (const entry of bridges) {
        if (!entry.bridge) continue;
        if (!mutedBridges.has(entry.bridge)) mutedBridges.set(entry.bridge, {
          element: entry.bridge,
          muted: entry.bridge.muted,
          stream: entry.bridge.srcObject,
          tracks: entry.bridge.srcObject?.getAudioTracks?.() || [],
          url: sourceUrl(entry.bridge),
        });
        entry.bridge.muted = true;
      }
    } catch (error) {
      capture.error = error?.message || String(error);
      void capture.stop();
    }
  }
  window.__openclawMeetingRemoteAudio = capture;
  try {
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    await refreshDevices();
    // Page CSP can prohibit blob AudioWorklet modules. This native WebAudio node
    // needs neither an injected module nor a CSP bypass and emits ~21 ms frames.
    processor = context.createScriptProcessor(512, 1, 1);
    processor.connect(context.destination);
    processor.onaudioprocess = ({ inputBuffer }) => {
      if (!capture.isCurrent()) { void capture.stop(); return; }
      if (deviceRefresh) return;
      // Recheck source identity before admitting an asynchronously delivered render quantum.
      if ([...entries.values()].some((entry) => !sameSource(entry))) { chunks.length = 0; scan(); return; }
      const data = inputBuffer.getChannelData(0);
      const pcm = new Uint8Array(data.length * 2);
      const view = new DataView(pcm.buffer);
      for (let index = 0; index < data.length; index++) view.setInt16(index * 2, Math.round(Math.max(-1, Math.min(1, data[index])) * 32767), true);
      chunks.push(pcm);
      // One second of 512-sample frames; stale backlog never grows without bound.
      if (chunks.length > 47) chunks.splice(0, chunks.length - 47);
    };
    await context.resume();
    if (!capture.isCurrent() || context.state !== "running") throw new Error("Meeting browser audio capture could not start. Enable audio playback in the meeting tab and retry.");
    scan();
    if (capture.error) throw new Error(capture.error);
    observer = new MutationObserver(scan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("play", scan, true);
    document.addEventListener("loadedmetadata", scan, true);
    window.addEventListener("pagehide", onPageHide);
    timer = setInterval(scan, 100);
    return JSON.stringify({ captureId, isolated: true });
  } catch (error) {
    await capture.stop();
    throw error;
  }
}`;
}
