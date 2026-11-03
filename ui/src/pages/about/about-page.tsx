import { createMemo, createSignal } from "solid-js";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { CONTROL_UI_BUILD_INFO } from "../../build-info.ts";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createTimeout } from "../../lib/reactive/timers.ts";
import { AboutView } from "./view.tsx";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-about-page": HTMLAttributes<HTMLElement>;
    }
  }
}

// Mirrors about-clawd-wave so the next poke can replay the settled animation.
const CLAWD_WAVE_MS = 1400;

export function AboutPage() {
  const context = useApplication();
  const gateway = createMemo(() => projectGateway(context.gateway));
  const [clawdWaving, setClawdWaving] = createSignal(false);
  const waveReset = createTimeout(() => setClawdWaving(false), CLAWD_WAVE_MS);

  function pokeClawd() {
    if (clawdWaving()) {
      return;
    }
    setClawdWaving(true);
    waveReset.schedule();
  }

  // The connected Gateway reports its own startup-bound identity; never infer it from this UI build.
  const gatewayBuild = createMemo(() => {
    const server = gateway().read().snapshot.hello?.server;
    return {
      version: server?.version?.trim() || null,
      commit: server?.commit ?? null,
      builtAt: server?.builtAt ?? null,
    };
  });

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
          gateway={gatewayBuild()}
          clawdWaving={clawdWaving()}
          onPokeClawd={pokeClawd}
        />
      </SettingsWorkspace>
    </openclaw-about-page>
  );
}
