import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, createSignal, onSettled } from "solid-js";
import {
  DEFAULT_BACKGROUND_PREFERENCE,
  USER_BACKGROUND_MAX_INPUT_BYTES,
  USER_BACKGROUND_PREFERENCE_KEY,
  selectBackgroundSource,
  type BackgroundPreference,
} from "../../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import type { UsersBackgroundResult } from "../../../../packages/gateway-protocol/src/schema/users-background.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  adoptCommittedBackgroundPreference,
  resolveServerUiPrefWriteStatus,
  retryServerUiPrefWrite,
} from "../../app/server-prefs-controls.ts";
import { canSyncAppearancePreference } from "../../app/server-prefs-profile-runtime.ts";
import { subscribeServerUiPrefWrites } from "../../app/server-prefs.ts";
import { patchSettings } from "../../app/settings.ts";
import {
  backgroundImageReadIdentity,
  readBackgroundImage,
} from "../../components/session-background-image.ts";
import type { SessionBackground } from "../../components/session-background.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { readBlobAsDataUrl } from "../../lib/blob-data-url.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";

registerEnglishCatalog(registerSettingsEnglish);
type BackgroundSnapshot = Extract<UsersBackgroundResult, { status: "ok" }>;
type BackgroundScope = { client: GatewayBrowserClient; profileId: string };

async function readFileBase64(file: File): Promise<string> {
  const dataUrl = await readBlobAsDataUrl(file, {
    readError: "Image could not be read",
    invalidResultError: "Image could not be read",
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

export function createAppearanceBackground(
  application: ApplicationContext,
  host: () => HTMLElement,
  previewCanvas: () => SessionBackground,
  fileInput: () => HTMLInputElement | undefined,
) {
  // Owner publications can arrive during another component's tracked computation.
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const publish = () => setRevision((value) => value + 1);
  const [message, setMessage] = createSignal<{
    kind: "error" | "status";
    text: string;
  } | null>(null);

  let connected = false;
  let imageUrl: string | null = null;
  let metadata:
    | (BackgroundScope & {
        revision: number;
        snapshot: BackgroundSnapshot;
      })
    | null = null;
  let metadataAbort: AbortController | undefined;
  let metadataKey: readonly unknown[] = [];

  const isConnected = () => connected && host().isConnected;
  const busy = () => mutationScope !== null;
  const canvasPreview = () => previewOwner !== null;
  const previewPreference = () => {
    revision();
    return canvasPreview() ? readPreference() : undefined;
  };

  async function readMetadata() {
    metadataAbort?.abort();
    const scope = captureScope();
    const requestedRevision = metadataRevision;
    if (!scope) {
      metadata = null;
      return;
    }
    const controller = new AbortController();
    metadataAbort = controller;
    try {
      const result = await scope.client.request<UsersBackgroundResult>(
        "users.background.get",
        {},
        { signal: controller.signal },
      );
      if (!owns(scope) || controller.signal.aborted) {
        return;
      }
      metadata =
        result.status === "ok" ? { ...scope, revision: requestedRevision, snapshot: result } : null;
      refreshPreview();
      publish();
    } catch (error) {
      if (owns(scope) && !controller.signal.aborted) {
        setMessage({ kind: "error", text: formatUiError(error) });
      }
    }
  }
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let previewPointer: number | null = null;
  let previewResize: ResizeObserver | null = null;
  let previewSuppressedUntilPointerUp = false;
  let previewOwner: {
    canvas: HTMLElement;
    client: GatewayBrowserClient | null;
    phase: ApplicationContext["gateway"]["snapshot"]["phase"];
    profileId: string | undefined;
    gatewayUrl: string;
  } | null = null;
  let metadataRevision = 0;
  let mutationScope: BackgroundScope | null = null;
  let imagePreview: { identity: string; controller: AbortController } | null = null;
  function captureScope(): BackgroundScope | null {
    const snapshot = application.gateway.snapshot;
    return snapshot.phase === "connected" && snapshot.client && snapshot.selfUser?.id
      ? { client: snapshot.client, profileId: snapshot.selfUser.id }
      : null;
  }

  function owns(scope: BackgroundScope): boolean {
    const current = captureScope();
    return (
      isConnected() && current?.client === scope.client && current.profileId === scope.profileId
    );
  }

  function readSnapshot(): BackgroundSnapshot | null {
    const value = metadata;
    return value && value.revision === metadataRevision && owns(value) ? value.snapshot : null;
  }

  function readPreference(): BackgroundPreference {
    return application.theme.settings.background ?? DEFAULT_BACKGROUND_PREFERENCE;
  }

  function readWriteStatus() {
    return resolveServerUiPrefWriteStatus(
      "background",
      application.gateway.connection.gatewayUrl,
      captureScope()?.profileId,
    );
  }

  function canUpload(): boolean {
    return Boolean(
      captureScope() && canSyncAppearancePreference(application, "background") === true,
    );
  }

  function releasePreview() {
    imagePreview?.controller.abort();
    imagePreview = null;
    if (imageUrl) {
      URL.revokeObjectURL(imageUrl);
    }
    imageUrl = null;
    publish();
  }

  function retireChangedPreview() {
    const assetId = readSnapshot()?.asset?.assetId;
    const identity = assetId ? backgroundImageReadIdentity(application, assetId) : null;
    if (imagePreview && imagePreview.identity !== identity) {
      releasePreview();
    }
  }

  function refreshPreview() {
    if (!isConnected()) {
      return;
    }
    const currentScope = captureScope();
    const source = readPreference().source;
    const key = [
      currentScope?.client ?? null,
      currentScope?.profileId ?? null,
      metadataRevision,
      source.kind === "custom" ? source.assetId : null,
    ];
    if (
      key.some((value, index) => value !== metadataKey[index]) ||
      key.length !== metadataKey.length
    ) {
      metadataKey = key;
      void readMetadata();
    }
    retireChangedCanvasPreview();
    retireChangedPreview();
    const context = application;
    const assetId = readSnapshot()?.asset?.assetId;
    const identity = assetId ? backgroundImageReadIdentity(context, assetId) : null;
    if (!assetId || !identity || imagePreview) {
      return;
    }
    const preview = { identity, controller: new AbortController() };
    imagePreview = preview;
    void readBackgroundImage(context, assetId, {
      signal: preview.controller.signal,
      isCurrent: () =>
        isConnected() && imagePreview === preview && readSnapshot()?.asset?.assetId === assetId,
    })
      .then((url) => {
        if (!isConnected() || imagePreview !== preview) {
          URL.revokeObjectURL(url);
          return;
        }
        imageUrl = url;
        publish();
      })
      .catch(() => {
        if (imagePreview === preview && !preview.controller.signal.aborted) {
          setMessage({ kind: "error", text: t("configView.appearance.background.unavailable") });
        }
      });
  }

  function retireMutation() {
    mutationScope = null;
    publish();
    setMessage(null);
  }

  function retireChangedCanvasPreview() {
    const owner = previewOwner;
    const context = application;
    if (
      owner &&
      (owner.client !== context.gateway.snapshot.client ||
        owner.phase !== context.gateway.snapshot.phase ||
        owner.profileId !== context.gateway.snapshot.selfUser?.id ||
        owner.gatewayUrl !== context.gateway.connection.gatewayUrl ||
        readPreference().source.kind === "none")
    ) {
      dismissCanvasPreview();
    }
  }

  function clearPreviewTimer() {
    if (previewTimer !== undefined) {
      clearTimeout(previewTimer);
      previewTimer = undefined;
    }
  }

  const dismissCanvasPreview = () => {
    clearPreviewTimer();
    const pointer = previewPointer;
    previewPointer = null;
    previewSuppressedUntilPointerUp ||= pointer !== null;
    previewResize?.disconnect();
    previewResize = null;
    previewOwner?.canvas.removeAttribute("data-background-preview");
    previewOwner = null;
    publish();
    host().removeAttribute("data-background-preview");
    for (const edge of ["top", "left", "width", "height"]) {
      host().style.removeProperty(`--settings-background-preview-${edge}`);
    }
    // Retire the image owner immediately, including during a deferred route render.
    previewCanvas().presented = false;
  };

  function showCanvasPreview() {
    const context = application;
    if (
      !isConnected() ||
      busy() ||
      previewSuppressedUntilPointerUp ||
      readPreference().source.kind === "none"
    ) {
      return;
    }
    const canvas = host().closest<HTMLElement>(".content");
    if (!canvas) {
      return;
    }
    if (!canvasPreview()) {
      const bounds = canvas.getBoundingClientRect();
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      host().style.setProperty("--settings-background-preview-top", `${bounds.top}px`);
      host().style.setProperty("--settings-background-preview-left", `${bounds.left}px`);
      host().style.setProperty("--settings-background-preview-width", `${width}px`);
      host().style.setProperty("--settings-background-preview-height", `${height}px`);
      // Docks and responsive chrome can change the canvas without window resize.
      // Cancel rather than leaving a layer over newly exposed navigation.
      previewResize = new ResizeObserver(() => {
        if (canvas.clientWidth !== width || canvas.clientHeight !== height) {
          dismissCanvasPreview();
        }
      });
      previewResize.observe(canvas);
    }
    clearPreviewTimer();
    previewOwner = {
      canvas,
      client: context.gateway.snapshot.client,
      phase: context.gateway.snapshot.phase,
      profileId: context.gateway.snapshot.selfUser?.id,
      gatewayUrl: context.gateway.connection.gatewayUrl,
    };
    // Escape retires the bridge immediately, even when another key reopens it before render.
    previewCanvas().presented = true;
    publish();
    canvas.setAttribute("data-background-preview", "");
    host().setAttribute("data-background-preview", "");
    if (previewPointer === null) {
      previewTimer = setTimeout(dismissCanvasPreview, 1200);
    }
  }

  const startCanvasPreview = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }
    // SAFETY: renderAppearanceBackground binds this callback directly to its range input.
    const input = event.currentTarget as HTMLInputElement;
    if (input.disabled) {
      return;
    }
    previewSuppressedUntilPointerUp = false;
    previewPointer = event.pointerId;
    showCanvasPreview();
  };

  const endCanvasPreview = (event: PointerEvent) => {
    previewSuppressedUntilPointerUp = false;
    if (previewPointer !== event.pointerId) {
      return;
    }
    previewPointer = null;
    if (canvasPreview()) {
      showCanvasPreview();
    }
  };

  const onPreviewEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      dismissCanvasPreview();
    }
  };

  const onPreviewKey = (event: KeyboardEvent) => {
    if (
      [
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "PageUp",
        "PageDown",
      ].includes(event.key)
    ) {
      previewSuppressedUntilPointerUp = false;
      showCanvasPreview();
    }
  };

  function change(patch: Partial<BackgroundPreference>) {
    if (busy()) {
      return;
    }
    patchSettings({ background: { ...readPreference(), ...patch } });
    application.theme.refresh();
    setMessage(null);
  }

  const chooseFile = () => fileInput()?.click();

  function selectSource(kind: BackgroundPreference["source"]["kind"]) {
    const asset = readSnapshot()?.asset;
    if (kind === "custom") {
      if (asset) {
        change(
          selectBackgroundSource(
            { kind, assetId: asset.assetId },
            application.theme.settings.background,
          ),
        );
      } else {
        chooseFile();
      }
      return;
    }
    change(selectBackgroundSource({ kind }, application.theme.settings.background));
  }

  async function mutate(file?: File) {
    const scope = captureScope();
    if (!scope || !canUpload() || busy() || readWriteStatus().status !== "saved") {
      return;
    }
    if (
      file &&
      (!file.size ||
        file.size > USER_BACKGROUND_MAX_INPUT_BYTES ||
        (file.type !== "" && !["image/jpeg", "image/png", "image/webp"].includes(file.type)))
    ) {
      setMessage({ kind: "error", text: t("configView.appearance.background.invalidFile") });
      return;
    }
    dismissCanvasPreview();
    mutationScope = scope;
    publish();
    setMessage({
      kind: "status",
      text: t(
        file
          ? "configView.appearance.background.uploading"
          : "configView.appearance.background.removing",
      ),
    });
    const isCurrent = () => owns(scope) && mutationScope === scope;
    try {
      const imageBase64 = file ? await readFileBase64(file) : undefined;
      if (!isCurrent()) {
        return;
      }
      // Read the authoritative image/preference pair before the guarded mutation;
      // another browser's later edit conflicts instead of being overwritten.
      const current = await scope.client.request<UsersBackgroundResult>("users.background.get", {});
      if (!isCurrent()) {
        return;
      }
      if (current.status !== "ok") {
        throw new Error(t("configView.appearance.background.profileRequired"));
      }
      const expected = {
        expectedAssetId: current.asset?.assetId ?? null,
        expectedPreference: current.preference,
      };
      const result = await scope.client.request<UsersBackgroundResult>(
        file ? "users.background.upload" : "users.background.remove",
        file ? { ...expected, imageBase64 } : expected,
      );
      if (!isCurrent()) {
        return;
      }
      if (result.status !== "ok") {
        throw new Error(
          t(
            result.status === "conflict"
              ? "configView.appearance.background.conflict"
              : "configView.appearance.background.profileRequired",
          ),
        );
      }
      adoptCommittedBackgroundPreference({
        client: scope.client,
        profileId: scope.profileId,
        scope: application.gateway.connection.gatewayUrl,
        preference: result.preference,
        expectedPreference: current.preference,
        isCurrent,
      });
      metadata = { ...scope, revision: metadataRevision, snapshot: result };
      application.theme.refresh();
      setMessage({
        kind: "status",
        text: t(
          file
            ? "configView.appearance.background.saved"
            : "configView.appearance.background.removed",
        ),
      });
    } catch (error) {
      if (isCurrent()) {
        setMessage({ kind: "error", text: formatUiError(error) });
      }
    } finally {
      if (isCurrent()) {
        publish();
        mutationScope = null;
      }
    }
  }

  function viewProps() {
    revision();
    const scope = captureScope();
    const writeStatus = readWriteStatus();
    const displayedMessage =
      message() ??
      (writeStatus.status === "error" && canUpload()
        ? {
            kind: "error" as const,
            text: writeStatus.error ?? t("configView.appearance.background.saveFailed"),
          }
        : writeStatus.status === "pending"
          ? { kind: "status" as const, text: t("common.saving") }
          : null);
    return {
      preference: readPreference(),
      imageUrl,
      hasImage: Boolean(readSnapshot()?.asset),
      busy: busy(),
      uploadAllowed: canUpload() && writeStatus.status === "saved",
      scopeHint: !scope
        ? t("configView.appearance.background.browserOnly")
        : !canUpload()
          ? t("configView.appearance.background.readOnly")
          : t("configView.appearance.background.private"),
      message: displayedMessage,
      onSource: (source: BackgroundPreference["source"]["kind"]) => selectSource(source),
      onChange: (patch: Partial<BackgroundPreference>) => change(patch),
      onChooseImage: chooseFile,
      onRemoveImage: () => void mutate(),
      onFile: (file: File) => void mutate(file),
      onPreviewStart: startCanvasPreview,
      onPreviewInput: () => showCanvasPreview(),
      onPreviewEnd: endCanvasPreview,
      onPreviewKey,
      onPreviewCancel: dismissCanvasPreview,
      onRetry:
        !message() && writeStatus.status === "error" && canUpload()
          ? () => {
              retryServerUiPrefWrite(
                "background",
                application.gateway.connection.gatewayUrl,
                scope?.profileId,
              );
              publish();
            }
          : undefined,
    };
  }
  onSettled(() => {
    connected = true;
    const ownerWindow = host().ownerDocument.defaultView ?? window;
    const document = host().ownerDocument;
    const subscriptions = [
      // Revoke an active preview immediately when its selected background changes.
      application.theme.subscribe(() => {
        retireChangedCanvasPreview();
        refreshPreview();
        publish();
      }),
      // Connection receipts retire upload and image-preview authority synchronously.
      application.gateway.subscribe(() => {
        if ((mutationScope && !owns(mutationScope)) || (metadata && !owns(metadata))) {
          retireMutation();
        }
        retireChangedPreview();
        retireChangedCanvasPreview();
        refreshPreview();
        publish();
      }),
      application.gateway.subscribeEvents((event) => {
        if (event.event !== "users.prefs.changed" || !isConnected() || !captureScope()) {
          return;
        }
        const keys = asNullableRecord(event.payload)?.keys;
        if (Array.isArray(keys) && !keys.includes(USER_BACKGROUND_PREFERENCE_KEY)) {
          return;
        }
        metadataRevision += 1;
        releasePreview();
        refreshPreview();
        publish();
      }),
      subscribeServerUiPrefWrites(publish),
      application.router.subscribe(dismissCanvasPreview), // Retire the canvas before route rendering.
      listen(ownerWindow, "blur", dismissCanvasPreview),
      listen(ownerWindow, "resize", dismissCanvasPreview),
      listen(document, "keydown", { handleEvent: onPreviewEscape }, true),
      listen(document, "visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          dismissCanvasPreview();
        }
      }),
      listen(document, "pointerup", { handleEvent: endCanvasPreview }, true),
      listen(document, "pointercancel", dismissCanvasPreview, true),
    ];
    refreshPreview();
    publish();
    return () => {
      connected = false;
      for (const stop of subscriptions) {
        stop();
      }
      metadataAbort?.abort();
      dismissCanvasPreview();
      retireMutation();
      releasePreview();
    };
  });
  return {
    viewProps: createMemo(viewProps),
    previewPreference,
    previewPresented: () => {
      revision();
      return canvasPreview();
    },
  };
}
