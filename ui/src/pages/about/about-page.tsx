import { createMemo, createSignal, onSettled } from "solid-js";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { CONTROL_UI_BUILD_INFO } from "../../build-info.ts";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createTimeout } from "../../lib/reactive/timers.ts";
import { AboutView, type AboutCommitCopyState } from "./view.tsx";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-about-page": HTMLAttributes<HTMLElement>;
    }
  }
}

const COPY_RESULT_VISIBLE_MS = 1800;
// Mirrors about-clawd-wave so the next poke can replay the settled animation.
const CLAWD_WAVE_MS = 1400;

export function AboutPage() {
  const context = useApplication();
  const gateway = createMemo(() => projectGateway(context.gateway));
  const [copyState, setCopyState] = createSignal<AboutCommitCopyState>("idle");
  const [clawdWaving, setClawdWaving] = createSignal(false);
  let disposed = false;
  const copyReset = createTimeout(() => setCopyState("idle"), COPY_RESULT_VISIBLE_MS);
  const waveReset = createTimeout(() => setClawdWaving(false), CLAWD_WAVE_MS);
  onSettled(() => () => {
    disposed = true;
  });

  function pokeClawd() {
    if (clawdWaving()) {
      return;
    }
    setClawdWaving(true);
    waveReset.schedule();
  }

  async function copyCommit() {
    const commit = CONTROL_UI_BUILD_INFO.commit;
    if (!commit || copyState() === "copying") {
      return;
    }
    copyReset.cancel();
    setCopyState("copying");
    const copied = await copyToClipboard(commit, () => !disposed);
    if (disposed) {
      return;
    }
    setCopyState(copied ? "copied" : "error");
    copyReset.schedule();
  }

  function gatewayVersion() {
    const snapshot = gateway().read().snapshot;
    return snapshot.hello?.server?.version?.trim() || null;
  }

  return (
    <openclaw-about-page>
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
    </openclaw-about-page>
  );
}
