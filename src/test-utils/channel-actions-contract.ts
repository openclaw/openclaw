import { expect, it } from "vitest";
import type { ChannelMessageCapability } from "../channels/plugins/message-capabilities.js";
import type { ChannelMessageActionName, ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";

type ChannelActionsContractCase = {
  name: string;
  cfg: OpenClawConfig;
  expectedActions: readonly ChannelMessageActionName[];
  expectedCapabilities?: readonly ChannelMessageCapability[];
  beforeTest?: () => void;
};

export function installChannelActionsContractSuite(params: {
  plugin: Pick<ChannelPlugin, "id" | "actions">;
  cases: readonly ChannelActionsContractCase[];
  unsupportedAction?: ChannelMessageActionName;
}) {
  it("exposes the base message actions contract", () => {
    expect(params.plugin.actions).toBeDefined();
    expect(typeof params.plugin.actions?.listActions).toBe("function");
  });

  for (const testCase of params.cases) {
    it(`actions contract: ${testCase.name}`, () => {
      testCase.beforeTest?.();

      const actions = params.plugin.actions?.listActions?.({ cfg: testCase.cfg }) ?? [];
      const capabilities = params.plugin.actions?.getCapabilities?.({ cfg: testCase.cfg }) ?? [];

      expect(actions).toEqual([...new Set(actions)]);
      expect(capabilities).toEqual([...new Set(capabilities)]);
      expect(actions.toSorted()).toEqual([...testCase.expectedActions].toSorted());
      expect(capabilities.toSorted()).toEqual(
        [...(testCase.expectedCapabilities ?? [])].toSorted(),
      );

      if (params.plugin.actions?.supportsAction) {
        for (const action of testCase.expectedActions) {
          expect(params.plugin.actions.supportsAction({ action })).toBe(true);
        }
        if (
          params.unsupportedAction &&
          !testCase.expectedActions.includes(params.unsupportedAction)
        ) {
          expect(params.plugin.actions.supportsAction({ action: params.unsupportedAction })).toBe(
            false,
          );
        }
      }
    });
  }
}
