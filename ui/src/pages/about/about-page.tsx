import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { CONTROL_UI_BUILD_INFO } from "../../build-info.ts";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { PageLayout } from "../page-layout.tsx";
import { AboutView, type AboutCommitCopyState } from "./view.tsx";

const COPY_RESULT_VISIBLE_MS = 1800;
// Mirrors about-clawd-wave so the next poke can replay the settled animation.
const CLAWD_WAVE_MS = 1400;

function AboutPageContent() {
  const context = useApplication();
  const gateway = projectGateway(untrack(() => context.gateway));
  createEffect(
    () => context.gateway,
    (source) => gateway.replaceSource(source),
  );
  const [copyState, setCopyState] = createSignal<AboutCommitCopyState>("idle");
  const [clawdWaving, setClawdWaving] = createSignal(false);
  let disposed = false;
  let copyResetTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let waveResetTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  onCleanup(() => {
    disposed = true;
    globalThis.clearTimeout(copyResetTimer);
    globalThis.clearTimeout(waveResetTimer);
  });

  function pokeClawd() {
    if (clawdWaving()) {
      return;
    }
    setClawdWaving(true);
    waveResetTimer = globalThis.setTimeout(() => {
      waveResetTimer = undefined;
      setClawdWaving(false);
    }, CLAWD_WAVE_MS);
  }

  async function copyCommit() {
    const commit = CONTROL_UI_BUILD_INFO.commit;
    if (!commit || copyState() === "copying") {
      return;
    }
    globalThis.clearTimeout(copyResetTimer);
    copyResetTimer = undefined;
    setCopyState("copying");
    const copied = await copyToClipboard(commit, () => !disposed);
    if (disposed) {
      return;
    }
    setCopyState(copied ? "copied" : "error");
    copyResetTimer = globalThis.setTimeout(() => {
      copyResetTimer = undefined;
      setCopyState("idle");
    }, COPY_RESULT_VISIBLE_MS);
  }

  function gatewayVersion() {
    const snapshot = gateway.read().snapshot;
    return snapshot.phase === "connected" ? snapshot.hello?.server?.version?.trim() || null : null;
  }

  return (
    <>
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
        <section class="content-header">
          <div>
            <h1 class="page-title">{t("tabs.about")}</h1>
          </div>
        </section>
      </ShellLayoutBoundary>
      <SettingsWorkspace>
        <AboutView
          buildInfo={CONTROL_UI_BUILD_INFO}
          gatewayVersion={gatewayVersion()}
          copyState={copyState()}
          onCopyCommit={() => void copyCommit()}
          clawdWaving={clawdWaving()}
          onPokeClawd={pokeClawd}
        />
      </SettingsWorkspace>
    </>
  );
}

export const AboutPage = defineSolidBridge(
  "openclaw-about-page",
  (_props, host) => (
    <PageLayout host={host}>
      <AboutPageContent />
    </PageLayout>
  ),
  { properties: {} },
);
