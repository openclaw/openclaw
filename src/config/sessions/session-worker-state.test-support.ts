import { it as baseIt } from "vitest";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";

export const it = baseIt.extend<{ state: OpenClawTestState }>({
  state: [
    async ({ task: _task }, use) => withOpenClawTestState({ scenario: "minimal" }, use),
    { auto: true },
  ],
});
