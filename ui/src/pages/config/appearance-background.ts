import { consume } from "@lit/context";
import { Task } from "@lit/task";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { html } from "lit";
import { property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import {
  DEFAULT_BACKGROUND_PREFERENCE,
  USER_BACKGROUND_MAX_INPUT_BYTES,
  USER_BACKGROUND_PREFERENCE_KEY,
  selectBackgroundSource,
  type BackgroundPreference,
} from "../../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import type { UsersBackgroundResult } from "../../../../packages/gateway-protocol/src/schema/users-background.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
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
import type { SessionBackground } from "../../components/session-background.ts";
import "../../components/session-background.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderAppearanceBackground } from "./view-appearance-background.ts";

registerSettingsEnglish();
type BackgroundSnapshot = Extract<UsersBackgroundResult, { status: "ok" }>;
type BackgroundScope = { client: GatewayBrowserClient; profileId: string };

async function readFileBase64(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "load",
      () => {
        if (typeof reader.result !== "string") {
          reject(new Error("Image could not be read"));
          return;
        }
        resolve(reader.result.slice(reader.result.indexOf(",") + 1));
      },
      { once: true },
    );
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("Image could not be read")),
      { once: true },
    );
    reader.readAsDataURL(file);
  });
}

export class AppearanceBackground extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  @property({ attribute: false })
  context?: ApplicationContext;
  @state() private busy = false;
  @state() private message: { kind: "error" | "status"; text: string } | null = null;
  @state() private imageUrl: string | null = null;
  @state() private canvasPreview = false;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private previewPointer: number | null = null;
  private previewResize: ResizeObserver | null = null;
  private previewSuppressedUntilPointerUp = false;
  private previewOwner: {
    canvas: HTMLElement;
    context: ApplicationContext;
    client: GatewayBrowserClient | null;
    phase: ApplicationContext["gateway"]["snapshot"]["phase"];
    profileId: string | undefined;
    gatewayUrl: string;
  } | null = null;
  private metadataRevision = 0;
  private mutationGeneration = 0;
  private mutationScope: BackgroundScope | null = null;
  private preview: { identity: string; controller: AbortController } | null = null;
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.theme,
      (theme, notify) =>
        theme.subscribe(() => {
          this.retireChangedCanvasPreview();
          notify();
        }),
    )
    .watch(
      () => this.context?.gateway,
      (gateway, notify) =>
        gateway.subscribe(() => {
          if (
            (this.mutationScope && !this.owns(this.mutationScope)) ||
            (this.metadata.value && !this.owns(this.metadata.value))
          ) {
            this.retireMutation();
          }
          this.retireChangedPreview();
          this.retireChangedCanvasPreview();
          notify();
        }),
    )
    .watch(
      () => this.context?.gateway,
      (gateway, notify) =>
        gateway.subscribeEvents((event) => {
          if (
            event.event !== "users.prefs.changed" ||
            !this.isConnected ||
            this.context?.gateway !== gateway ||
            !this.scope()
          ) {
            return;
          }
          const keys = asNullableRecord(event.payload)?.keys;
          if (Array.isArray(keys) && !keys.includes(USER_BACKGROUND_PREFERENCE_KEY)) {
            return;
          }
          // The server scopes publications to this profile and its aliases. A
          // retained image can change even while the selected source stays None/Theme.
          this.metadataRevision += 1;
          this.releasePreview();
          notify();
        }),
    )
    .effect(
      () => this.context,
      () => subscribeServerUiPrefWrites(() => this.requestUpdate()),
    )
    .effect(
      () => this.context?.router,
      (router) => router.subscribe(() => this.dismissCanvasPreview()),
    )
    .effect(
      () => this.ownerDocument.defaultView,
      (window) => {
        const document = this.ownerDocument;
        const visibility = () => {
          if (document.visibilityState === "hidden") {
            this.dismissCanvasPreview();
          }
        };
        const listeners = new AbortController();
        const options = { signal: listeners.signal };
        const capture = { ...options, capture: true };
        window.addEventListener("blur", this.dismissCanvasPreview, options);
        window.addEventListener("resize", this.dismissCanvasPreview, options);
        document.addEventListener("keydown", this.onPreviewEscape, capture);
        document.addEventListener("visibilitychange", visibility, options);
        document.addEventListener("pointerup", this.endCanvasPreview, capture);
        document.addEventListener("pointercancel", this.dismissCanvasPreview, capture);
        return () => listeners.abort();
      },
    );

  private readonly metadata = new Task(this, {
    args: () => {
      const scope = this.scope();
      const source = this.context?.theme.settings.background?.source;
      return [
        scope?.client ?? null,
        scope?.profileId ?? null,
        this.metadataRevision,
        source?.kind === "custom" ? source.assetId : null,
      ] as const;
    },
    task: async ([client, profileId, revision], { signal }) => {
      if (!client || !profileId) {
        return null;
      }
      const result = await client.request<UsersBackgroundResult>(
        "users.background.get",
        {},
        { signal },
      );
      return result.status === "ok" ? { client, profileId, revision, snapshot: result } : null;
    },
    onError: (error) => {
      this.message = { kind: "error", text: formatUiError(error) };
    },
  });

  private scope(): BackgroundScope | null {
    const snapshot = this.context?.gateway.snapshot;
    return snapshot?.phase === "connected" && snapshot.client && snapshot.selfUser?.id
      ? { client: snapshot.client, profileId: snapshot.selfUser.id }
      : null;
  }

  private owns(scope: BackgroundScope): boolean {
    const current = this.scope();
    return (
      this.isConnected && current?.client === scope.client && current.profileId === scope.profileId
    );
  }

  private get snapshot(): BackgroundSnapshot | null {
    const value = this.metadata.value;
    return value && value.revision === this.metadataRevision && this.owns(value)
      ? value.snapshot
      : null;
  }

  private get preference(): BackgroundPreference {
    return this.context?.theme.settings.background ?? DEFAULT_BACKGROUND_PREFERENCE;
  }

  private get writeStatus() {
    return resolveServerUiPrefWriteStatus(
      "background",
      this.context?.gateway.connection.gatewayUrl ?? "",
      this.scope()?.profileId,
    );
  }

  private canUpload(): boolean {
    return Boolean(
      this.scope() &&
      this.context &&
      canSyncAppearancePreference(this.context, "background") === true,
    );
  }

  private releasePreview() {
    this.preview?.controller.abort();
    this.preview = null;
    if (this.imageUrl) {
      URL.revokeObjectURL(this.imageUrl);
    }
    this.imageUrl = null;
  }

  private retireChangedPreview() {
    const assetId = this.snapshot?.asset?.assetId;
    const identity =
      this.context && assetId ? backgroundImageReadIdentity(this.context, assetId) : null;
    if (this.preview && this.preview.identity !== identity) {
      this.releasePreview();
    }
  }

  override willUpdate() {
    this.retireChangedCanvasPreview();
    this.retireChangedPreview();
    const context = this.context;
    const assetId = this.snapshot?.asset?.assetId;
    const identity = context && assetId ? backgroundImageReadIdentity(context, assetId) : null;
    if (!context || !assetId || !identity || this.preview) {
      return;
    }
    const preview = { identity, controller: new AbortController() };
    this.preview = preview;
    void readBackgroundImage(context, assetId, {
      signal: preview.controller.signal,
      isCurrent: () =>
        this.isConnected && this.preview === preview && this.snapshot?.asset?.assetId === assetId,
    })
      .then((url) => {
        if (!this.isConnected || this.preview !== preview) {
          URL.revokeObjectURL(url);
          return;
        }
        this.imageUrl = url;
      })
      .catch(() => {
        if (this.preview === preview && !preview.controller.signal.aborted) {
          this.message = { kind: "error", text: t("configView.appearance.background.unavailable") };
        }
      });
  }

  override disconnectedCallback() {
    this.dismissCanvasPreview();
    this.retireMutation();
    this.releasePreview();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private retireMutation() {
    this.mutationGeneration += 1;
    this.mutationScope = null;
    this.busy = false;
    this.message = null;
  }

  private retireChangedCanvasPreview() {
    const owner = this.previewOwner;
    const context = this.context;
    if (
      owner &&
      (owner.context !== context ||
        owner.client !== context?.gateway.snapshot.client ||
        owner.phase !== context?.gateway.snapshot.phase ||
        owner.profileId !== context?.gateway.snapshot.selfUser?.id ||
        owner.gatewayUrl !== context?.gateway.connection.gatewayUrl ||
        this.preference.source.kind === "none")
    ) {
      this.dismissCanvasPreview();
    }
  }

  private clearPreviewTimer() {
    if (this.previewTimer !== undefined) {
      clearTimeout(this.previewTimer);
      this.previewTimer = undefined;
    }
  }

  private readonly dismissCanvasPreview = () => {
    this.clearPreviewTimer();
    const pointer = this.previewPointer;
    this.previewPointer = null;
    this.previewSuppressedUntilPointerUp ||= pointer !== null;
    this.previewResize?.disconnect();
    this.previewResize = null;
    this.previewOwner?.canvas.removeAttribute("data-background-preview");
    this.previewOwner = null;
    this.canvasPreview = false;
    this.removeAttribute("data-background-preview");
    for (const edge of ["top", "left", "width", "height"]) {
      this.style.removeProperty(`--settings-background-preview-${edge}`);
    }
    // Retire the image owner immediately, including during a deferred route render.
    const canvas = this.querySelector<SessionBackground>("[data-background-preview-canvas]");
    if (canvas) {
      canvas.presented = false;
    }
  };

  private showCanvasPreview() {
    const context = this.context;
    if (
      !this.isConnected ||
      !context ||
      this.busy ||
      this.previewSuppressedUntilPointerUp ||
      this.preference.source.kind === "none"
    ) {
      return;
    }
    const canvas = this.closest<HTMLElement>(".content");
    if (!canvas) {
      return;
    }
    if (!this.canvasPreview) {
      const bounds = canvas.getBoundingClientRect();
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      this.style.setProperty("--settings-background-preview-top", `${bounds.top}px`);
      this.style.setProperty("--settings-background-preview-left", `${bounds.left}px`);
      this.style.setProperty("--settings-background-preview-width", `${width}px`);
      this.style.setProperty("--settings-background-preview-height", `${height}px`);
      // Docks and responsive chrome can change the canvas without window resize.
      // Cancel rather than leaving a layer over newly exposed navigation.
      this.previewResize = new ResizeObserver(() => {
        if (canvas.clientWidth !== width || canvas.clientHeight !== height) {
          this.dismissCanvasPreview();
        }
      });
      this.previewResize.observe(canvas);
    }
    this.clearPreviewTimer();
    this.previewOwner = {
      canvas,
      context,
      client: context.gateway.snapshot.client,
      phase: context.gateway.snapshot.phase,
      profileId: context.gateway.snapshot.selfUser?.id,
      gatewayUrl: context.gateway.connection.gatewayUrl,
    };
    this.canvasPreview = true;
    canvas.setAttribute("data-background-preview", "");
    this.setAttribute("data-background-preview", "");
    if (this.previewPointer === null) {
      this.previewTimer = setTimeout(this.dismissCanvasPreview, 1200);
    }
  }

  private readonly startCanvasPreview = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }
    // SAFETY: renderAppearanceBackground binds this callback directly to its range input.
    const input = event.currentTarget as HTMLInputElement;
    if (input.disabled) {
      return;
    }
    this.previewSuppressedUntilPointerUp = false;
    this.previewPointer = event.pointerId;
    this.showCanvasPreview();
  };

  private readonly endCanvasPreview = (event: PointerEvent) => {
    this.previewSuppressedUntilPointerUp = false;
    if (this.previewPointer !== event.pointerId) {
      return;
    }
    this.previewPointer = null;
    if (this.canvasPreview) {
      this.showCanvasPreview();
    }
  };

  private readonly onPreviewEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this.dismissCanvasPreview();
    }
  };

  private readonly onPreviewKey = (event: KeyboardEvent) => {
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
      this.previewSuppressedUntilPointerUp = false;
      this.showCanvasPreview();
    }
  };

  private change(patch: Partial<BackgroundPreference>) {
    if (!this.context || this.busy) {
      return;
    }
    patchSettings({ background: { ...this.preference, ...patch } });
    this.context.theme.refresh();
    this.message = null;
  }

  private chooseFile = () =>
    this.querySelector<HTMLInputElement>("[data-background-file]")?.click();

  private selectSource(kind: BackgroundPreference["source"]["kind"]) {
    const asset = this.snapshot?.asset;
    if (kind === "custom") {
      if (asset) {
        this.change(
          selectBackgroundSource(
            { kind, assetId: asset.assetId },
            this.context?.theme.settings.background,
          ),
        );
      } else {
        this.chooseFile();
      }
      return;
    }
    this.change(selectBackgroundSource({ kind }, this.context?.theme.settings.background));
  }

  private async mutate(file?: File) {
    const scope = this.scope();
    if (!scope || !this.canUpload() || this.busy || this.writeStatus.status !== "saved") {
      return;
    }
    if (
      file &&
      (!file.size ||
        file.size > USER_BACKGROUND_MAX_INPUT_BYTES ||
        (file.type !== "" && !["image/jpeg", "image/png", "image/webp"].includes(file.type)))
    ) {
      this.message = { kind: "error", text: t("configView.appearance.background.invalidFile") };
      return;
    }
    this.dismissCanvasPreview();
    const generation = ++this.mutationGeneration;
    this.mutationScope = scope;
    this.busy = true;
    this.message = {
      kind: "status",
      text: t(
        file
          ? "configView.appearance.background.uploading"
          : "configView.appearance.background.removing",
      ),
    };
    const isCurrent = () => this.owns(scope) && this.mutationGeneration === generation;
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
        scope: this.context?.gateway.connection.gatewayUrl,
        preference: result.preference,
        expectedPreference: current.preference,
        isCurrent,
      });
      this.context?.theme.refresh();
      await this.metadata.run();
      if (!isCurrent()) {
        return;
      }
      this.message = {
        kind: "status",
        text: t(
          file
            ? "configView.appearance.background.saved"
            : "configView.appearance.background.removed",
        ),
      };
    } catch (error) {
      if (isCurrent()) {
        this.message = { kind: "error", text: formatUiError(error) };
      }
    } finally {
      if (isCurrent()) {
        this.busy = false;
        this.mutationScope = null;
      }
    }
  }

  override render() {
    const scope = this.scope();
    const writeStatus = this.writeStatus;
    const message =
      this.message ??
      (writeStatus.status === "error" && this.canUpload()
        ? {
            kind: "error" as const,
            text: writeStatus.error ?? t("configView.appearance.background.saveFailed"),
          }
        : writeStatus.status === "pending"
          ? { kind: "status" as const, text: t("common.saving") }
          : null);
    return html`
      <openclaw-session-background
        class="settings-background-preview"
        data-background-preview-canvas
        .context=${this.context}
        .surface=${"preview"}
        .preferenceOverride=${this.canvasPreview ? this.preference : undefined}
        .presented=${live(this.canvasPreview)}
      ></openclaw-session-background>
      ${renderAppearanceBackground({
        preference: this.preference,
        imageUrl: this.imageUrl,
        hasImage: Boolean(this.snapshot?.asset),
        busy: this.busy,
        uploadAllowed: this.canUpload() && writeStatus.status === "saved",
        scopeHint: !scope
          ? t("configView.appearance.background.browserOnly")
          : !this.canUpload()
            ? t("configView.appearance.background.readOnly")
            : t("configView.appearance.background.private"),
        message,
        onSource: (source) => this.selectSource(source),
        onChange: (patch) => this.change(patch),
        onChooseImage: this.chooseFile,
        onRemoveImage: () => void this.mutate(),
        onFile: (file) => void this.mutate(file),
        onPreviewStart: this.startCanvasPreview,
        onPreviewInput: () => this.showCanvasPreview(),
        onPreviewEnd: this.endCanvasPreview,
        onPreviewKey: this.onPreviewKey,
        onPreviewCancel: this.dismissCanvasPreview,
        onRetry:
          !this.message && writeStatus.status === "error" && this.canUpload()
            ? () => {
                retryServerUiPrefWrite(
                  "background",
                  this.context!.gateway.connection.gatewayUrl,
                  scope?.profileId,
                );
                this.requestUpdate();
              }
            : undefined,
      })}
    `;
  }
}

if (!customElements.get("openclaw-appearance-background")) {
  customElements.define("openclaw-appearance-background", AppearanceBackground);
}
