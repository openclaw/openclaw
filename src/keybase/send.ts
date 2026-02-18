import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type KeybaseSendOpts = {
  accountId?: string;
  mediaUrl?: string;
  maxBytes?: number;
  timeoutMs?: number;
};

export type KeybaseSendResult = {
  messageId: string;
  timestamp?: number;
};

type KeybaseTarget =
  | { type: "user"; username: string }
  | { type: "team"; teamName: string; topicName?: string };

function parseTarget(raw: string): KeybaseTarget {
  let value = raw.trim();
  if (!value) {
    throw new Error("Keybase recipient is required");
  }
  if (value.toLowerCase().startsWith("keybase:")) {
    value = value.slice("keybase:".length).trim();
  }
  if (value.toLowerCase().startsWith("team:")) {
    const rest = value.slice("team:".length).trim();
    const parts = rest.split("#");
    return {
      type: "team",
      teamName: parts[0].trim(),
      topicName: parts[1]?.trim() || undefined,
    };
  }
  return { type: "user", username: value };
}

function buildChannelParam(target: KeybaseTarget): Record<string, unknown> {
  if (target.type === "team") {
    return {
      name: target.teamName,
      members_type: "team",
      ...(target.topicName ? { topic_name: target.topicName } : {}),
    };
  }
  return { name: target.username };
}

async function keybaseChatApi(payload: Record<string, unknown>): Promise<unknown> {
  const { stdout } = await execFileAsync("keybase", ["chat", "api", "-m", JSON.stringify(payload)]);
  return JSON.parse(stdout);
}

export async function sendMessageKeybase(
  to: string,
  text: string,
  opts: KeybaseSendOpts = {},
): Promise<KeybaseSendResult> {
  const target = parseTarget(to);
  const channel = buildChannelParam(target);

  if (opts.mediaUrl?.trim()) {
    const result = (await keybaseChatApi({
      method: "attach",
      params: {
        options: {
          channel,
          filename: opts.mediaUrl.trim(),
          title: text || undefined,
        },
      },
    })) as { result?: { id?: number } };
    return {
      messageId: result?.result?.id ? String(result.result.id) : "unknown",
    };
  }

  if (!text.trim()) {
    throw new Error("Keybase send requires text or media");
  }

  const result = (await keybaseChatApi({
    method: "send",
    params: {
      options: {
        channel,
        message: { body: text },
      },
    },
  })) as { result?: { id?: number } };

  return {
    messageId: result?.result?.id ? String(result.result.id) : "unknown",
  };
}
