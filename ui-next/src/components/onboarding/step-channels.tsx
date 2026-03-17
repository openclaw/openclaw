import {
  Globe,
  MessageSquare,
  Loader2,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGateway } from "@/hooks/use-gateway";

type Props = { onValidChange: (valid: boolean) => void };

type ChannelAccountSnapshot = {
  accountId?: string;
  configured?: boolean;
  running?: boolean;
  status?: string;
  label?: string;
};

type ChannelsStatusResponse = {
  channelOrder?: string[];
  channelLabels?: Record<string, string>;
  channels?: Record<string, { configured?: boolean }>;
  channelAccounts?: Record<string, ChannelAccountSnapshot[]>;
};

type ChannelEntry = {
  id: string;
  label: string;
  configured: boolean;
  running: boolean;
};

// Known token config paths per channel
const CHANNEL_TOKEN_PATHS: Record<string, { configKey: string; placeholder: string }> = {
  telegram: {
    configKey: "channels.telegram.botToken",
    placeholder: "Telegram Bot Token (from @BotFather)",
  },
  discord: { configKey: "channels.discord.botToken", placeholder: "Discord Bot Token" },
  slack: { configKey: "channels.slack.botToken", placeholder: "Slack Bot Token (xoxb-...)" },
};

type ProbeStatus = "idle" | "probing" | "success" | "error";

export function StepChannels({ onValidChange }: Props) {
  const { sendRpc } = useGateway();
  const [channels, setChannels] = useState<ChannelEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedChannel, setExpandedChannel] = useState<string | null>(null);
  const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({});
  const [probeStatus, setProbeStatus] = useState<Record<string, ProbeStatus>>({});
  const [probeError, setProbeError] = useState<Record<string, string>>({});
  const [primaryChannel, setPrimaryChannel] = useState<string>("web");

  const loadChannels = useCallback(async () => {
    try {
      const result = await sendRpc<ChannelsStatusResponse>("channels.status", {});
      const entries: ChannelEntry[] = [];
      const order = result.channelOrder ?? Object.keys(result.channels ?? {});
      const labels = result.channelLabels ?? {};

      for (const channelId of order) {
        const channelSummary = result.channels?.[channelId];
        const accounts = result.channelAccounts?.[channelId] ?? [];
        const configured = channelSummary?.configured ?? accounts.some((a) => a.configured);
        const running = accounts.some((a) => a.running);

        entries.push({
          id: channelId,
          label: labels[channelId] ?? channelId,
          configured,
          running,
        });
      }

      setChannels(entries);
    } catch {
      // Channels not available
    } finally {
      setLoading(false);
    }
  }, [sendRpc]);

  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  // Always valid — channels are optional
  useEffect(() => {
    onValidChange(true);
  }, [onValidChange]);

  // Save token via config.patch and probe
  const handleSaveToken = useCallback(
    async (channelId: string) => {
      const token = tokenInputs[channelId]?.trim();
      const configInfo = CHANNEL_TOKEN_PATHS[channelId];
      if (!token || !configInfo) {
        return;
      }

      setProbeStatus((prev) => ({ ...prev, [channelId]: "probing" }));
      setProbeError((prev) => ({ ...prev, [channelId]: "" }));

      try {
        // Write token to config
        await sendRpc("config.patch", {
          values: { [configInfo.configKey]: token },
        });

        // Probe to validate
        await sendRpc("channels.status", { probe: true, timeoutMs: 10000 });

        setProbeStatus((prev) => ({ ...prev, [channelId]: "success" }));

        // Reload channel status
        await loadChannels();
      } catch (err) {
        setProbeStatus((prev) => ({ ...prev, [channelId]: "error" }));
        setProbeError((prev) => ({
          ...prev,
          [channelId]: err instanceof Error ? err.message : "Token validation failed",
        }));
      }
    },
    [tokenInputs, sendRpc, loadChannels],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const configuredChannels = channels.filter((c) => c.id !== "web" && c.configured);
  const unconfiguredChannels = channels.filter((c) => c.id !== "web" && !c.configured);
  const configurableChannels = unconfiguredChannels.filter((c) => CHANNEL_TOKEN_PATHS[c.id]);
  const otherChannels = unconfiguredChannels.filter((c) => !CHANNEL_TOKEN_PATHS[c.id]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Messaging Channels</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Connect messaging platforms to interact with your agents. Web Chat is always available.
        </p>
      </div>

      {/* Web Chat — always enabled */}
      <div className="rounded-lg border border-primary/50 bg-primary/5 p-4">
        <div className="flex items-center gap-3">
          <Globe className="h-5 w-5 text-primary" />
          <div className="flex-1">
            <div className="font-medium text-sm">Web Chat</div>
            <div className="text-xs text-muted-foreground">
              Built-in chat interface — always available at /chat
            </div>
          </div>
          <Badge variant="default" className="text-xs">
            Active
          </Badge>
        </div>
      </div>

      {/* Configured channels */}
      {configuredChannels.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">Configured Channels</h3>
          {configuredChannels.map((ch) => (
            <div key={ch.id} className="rounded-lg border border-border p-4">
              <div className="flex items-center gap-3">
                <MessageSquare className="h-5 w-5 text-muted-foreground" />
                <div className="flex-1">
                  <div className="font-medium text-sm">{ch.label}</div>
                </div>
                <Badge variant={ch.running ? "default" : "outline"} className="text-xs">
                  {ch.running ? "Running" : "Configured"}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Configurable channels (with token input) */}
      {configurableChannels.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">Add a Channel</h3>
          {configurableChannels.map((ch) => {
            const isExpanded = expandedChannel === ch.id;
            const configInfo = CHANNEL_TOKEN_PATHS[ch.id];
            const status = probeStatus[ch.id] ?? "idle";
            const error = probeError[ch.id];

            return (
              <div key={ch.id} className="rounded-lg border border-border">
                {/* Channel header (clickable to expand) */}
                <button
                  type="button"
                  onClick={() => setExpandedChannel(isExpanded ? null : ch.id)}
                  className="w-full flex items-center gap-3 p-4 hover:bg-secondary/20 transition-colors"
                >
                  <MessageSquare className="h-5 w-5 text-muted-foreground" />
                  <div className="flex-1 text-left">
                    <div className="font-medium text-sm">{ch.label}</div>
                  </div>
                  {status === "success" ? (
                    <CheckCircle2 className="h-4 w-4 text-primary" />
                  ) : isExpanded ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>

                {/* Expanded config section */}
                {isExpanded && configInfo && (
                  <div className="px-4 pb-4 space-y-3 border-t border-border pt-3">
                    <div>
                      <label className="text-sm font-medium block mb-1.5">Bot Token</label>
                      <Input
                        type="password"
                        placeholder={configInfo.placeholder}
                        value={tokenInputs[ch.id] ?? ""}
                        onChange={(e) =>
                          setTokenInputs((prev) => ({ ...prev, [ch.id]: e.target.value }))
                        }
                      />
                    </div>
                    <div className="flex items-center gap-3">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleSaveToken(ch.id)}
                        disabled={status === "probing" || !tokenInputs[ch.id]?.trim()}
                      >
                        {status === "probing" && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                        Save & Test
                      </Button>
                      {status === "success" && (
                        <span className="flex items-center gap-1 text-xs text-primary">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Connected
                        </span>
                      )}
                      {status === "error" && (
                        <span className="flex items-center gap-1 text-xs text-destructive">
                          <AlertCircle className="h-3.5 w-3.5" /> {error}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Other available channels (no inline config) */}
      {otherChannels.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">Other Available Channels</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {otherChannels.map((ch) => (
              <div
                key={ch.id}
                className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground"
              >
                {ch.label}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Primary channel selector */}
      {(configuredChannels.length > 0 || channels.some((c) => c.id === "web")) && (
        <div className="rounded-lg border border-border p-4 space-y-3">
          <h3 className="text-sm font-semibold">Primary Channel</h3>
          <p className="text-xs text-muted-foreground">
            Select which channel to use for system notifications (configurable later).
          </p>
          <div className="flex flex-wrap gap-2">
            {[{ id: "web", label: "Web Chat" }, ...configuredChannels].map((ch) => (
              <button
                key={ch.id}
                type="button"
                onClick={() => setPrimaryChannel(ch.id)}
                className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                  primaryChannel === ch.id
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/50"
                }`}
              >
                {ch.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
