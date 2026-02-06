import { PubSub } from "@google-cloud/pubsub";
import type { ResolvedGoogleChatAccount } from "./accounts.js";

export type GoogleChatProbeResult = {
  ok: boolean;
  status: string;
  projectId?: string;
  subscriptionName?: string;
  topic?: string;
  error?: string;
};

export async function probeGoogleChat(
  account: ResolvedGoogleChatAccount,
  timeoutMs = 5000,
): Promise<GoogleChatProbeResult> {
  if (!account.projectId || !account.subscriptionName) {
    return {
      ok: false,
      status: "Not configured",
      error: "Missing projectId or subscriptionName",
    };
  }

  try {
    const pubsub = new PubSub({
      projectId: account.projectId,
      keyFilename: account.credentialsPath,
    });

    const subscription = pubsub.subscription(account.subscriptionName);

    // Use a timeout for the exists check
    const existsPromise = subscription.exists();
    const timeoutPromise = new Promise<[boolean]>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), timeoutMs),
    );

    const [exists] = await Promise.race([existsPromise, timeoutPromise]);

    if (!exists) {
      return {
        ok: false,
        status: "Subscription not found",
        projectId: account.projectId,
        subscriptionName: account.subscriptionName,
      };
    }

    const [metadata] = await subscription.getMetadata();

    return {
      ok: true,
      status: "Connected",
      projectId: account.projectId,
      subscriptionName: account.subscriptionName,
      topic: metadata.topic ?? undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: "Connection failed",
      projectId: account.projectId,
      subscriptionName: account.subscriptionName,
      error: errorMessage,
    };
  }
}
