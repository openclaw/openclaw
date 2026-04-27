import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ChannelMessageActionContext } from "./types.public.js";
export declare function dispatchChannelMessageAction(ctx: ChannelMessageActionContext): Promise<AgentToolResult<unknown> | null>;
