import { ContextProvider } from "@lit/context";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { normalizeApplicationContext } from "./application-context-fixtures.ts";

export {
  createApplicationGateway,
  createNavigationPreferencesFixture,
  hiddenScopeUpgradeCapability,
} from "./application-context-fixtures.ts";

export function createApplicationContextProvider(context: ApplicationContext) {
  const host = document.createElement("div");
  const provider = new ContextProvider(host, {
    context: applicationContext,
    initialValue: normalizeApplicationContext(context),
  });
  return Object.assign(host, {
    setContext: (value: ApplicationContext) =>
      provider.setValue(normalizeApplicationContext(value)),
  });
}

export type ApplicationContextProvider = ReturnType<typeof createApplicationContextProvider>;
