import type { ReactiveControllerHost } from "lit";
import { t } from "../../i18n/index.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { formatUiError } from "../../lib/format-error.ts";

type SaveState = { busy: boolean; error: string | null; notice: string | null };

export class CloudWorkerConfigSave {
  readonly state: SaveState = { busy: false, error: null, notice: null };

  constructor(private readonly host: ReactiveControllerHost) {}

  update(patch: Partial<SaveState>) {
    Object.assign(this.state, patch);
    this.host.requestUpdate();
  }

  async save(
    runtimeConfig: RuntimeConfigCapability,
    isCurrent: () => boolean,
    options: {
      build: (
        base: Readonly<Record<string, unknown>>,
      ) => { patch: Record<string, unknown>; replacePaths?: string[] } | { error: string };
      note: string;
      canDispatch: () => boolean;
      failed: () => string;
      success: () => string | void;
    },
  ): Promise<boolean> {
    this.update({ busy: true, error: null, notice: null });
    try {
      const patched = await runtimeConfig.patchFromSnapshot((base) => {
        const built = options.build(base);
        return "error" in built
          ? { error: t(`cloudWorkersPage.errors.${built.error}`) }
          : {
              options: {
                raw: built.patch,
                ...(built.replacePaths ? { replacePaths: built.replacePaths } : {}),
                note: options.note,
                canDispatch: options.canDispatch,
              },
            };
      });
      if (!isCurrent()) {
        return false;
      }
      if (!patched) {
        this.update({ error: runtimeConfig.state.lastError ?? options.failed() });
        return false;
      }
      this.update({ notice: options.success() ?? null });
      return true;
    } catch (error) {
      if (isCurrent()) {
        this.update({ error: formatUiError(error) });
      }
      return false;
    } finally {
      if (isCurrent()) {
        this.update({ busy: false });
      }
    }
  }
}
