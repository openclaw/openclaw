import { prepareStartupClientCredentials } from "../commands/startup-client-credentials.js";

export async function ensureNodeHostStateReady(): Promise<void> {
  await prepareStartupClientCredentials();
}
