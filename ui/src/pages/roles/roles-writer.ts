import type { UserProfile } from "../../../../packages/gateway-protocol/src/schema/users.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { RolePatch, RolePatchError } from "./role-catalog.ts";

type WriteState = { busy: boolean; error: string | null; notice: string | null };

/** Admits one role write at a time and keeps its outcome for the page. */
export class RolesWriter {
  readonly state: WriteState = { busy: false, error: null, notice: null };

  constructor(private readonly notify: () => void) {}

  update(patch: Partial<WriteState>) {
    Object.assign(this.state, patch);
    this.notify();
  }

  async patch(
    runtimeConfig: RuntimeConfigCapability,
    isCurrent: () => boolean,
    options: {
      build: (base: Readonly<Record<string, unknown>>) => RolePatch | RolePatchError;
      note: string;
      canDispatch: () => boolean;
      success: string;
    },
  ): Promise<boolean> {
    this.update({ busy: true, error: null, notice: null });
    try {
      const patched = await runtimeConfig.patchFromSnapshot((base) => {
        const built = options.build(base);
        return "error" in built
          ? { error: t("rolesPage.errors." + built.error) }
          : {
              options: {
                raw: built.patch,
                ...(built.replacePaths.length ? { replacePaths: built.replacePaths } : {}),
                note: options.note,
                canDispatch: options.canDispatch,
              },
            };
      });
      if (!isCurrent()) {
        return false;
      }
      if (!patched) {
        this.update({ error: runtimeConfig.state.lastError ?? t("rolesPage.saveFailed") });
        return false;
      }
      this.update({ notice: options.success });
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

  /** Moves people one at a time; each move reconnects that person under the new role. */
  async assign(
    client: GatewayBrowserClient,
    isCurrent: () => boolean,
    people: readonly Pick<UserProfile, "id" | "displayName">[],
    role: string,
  ): Promise<boolean> {
    this.update({ busy: true, error: null, notice: null });
    try {
      for (const person of people) {
        try {
          await client.request("users.setRole", { profileId: person.id, role });
        } catch (error) {
          if (isCurrent()) {
            this.update({
              error:
                t("rolesPage.assignFailed", { name: person.displayName ?? person.id }) +
                " " +
                formatUiError(error),
            });
          }
          return false;
        }
        if (!isCurrent()) {
          return false;
        }
      }
      return true;
    } finally {
      if (isCurrent()) {
        this.update({ busy: false });
      }
    }
  }
}
