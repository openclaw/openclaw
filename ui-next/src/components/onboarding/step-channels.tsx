import { Globe, MessageSquare, Loader2 } from "lucide-react";
import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
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

export function StepChannels({ onValidChange }: Props) {
  const { sendRpc } = useGateway();
  const [channels, setChannels] = useState<ChannelEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
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
    };
    void load();
  }, [sendRpc]);

  // Always valid -- channels are optional
  useEffect(() => {
    onValidChange(true);
  }, [onValidChange]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const configuredChannels = channels.filter((c) => c.id !== "web" && c.configured);
  const unconfiguredChannels = channels.filter((c) => c.id !== "web" && !c.configured);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Messaging Channels</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Connect messaging platforms to interact with your agents. Web Chat is always available.
        </p>
      </div>

      {/* Web Chat -- always enabled */}
      <div className="rounded-lg border border-primary/50 bg-primary/5 p-4">
        <div className="flex items-center gap-3">
          <Globe className="h-5 w-5 text-primary" />
          <div className="flex-1">
            <div className="font-medium text-sm">Web Chat</div>
            <div className="text-xs text-muted-foreground">
              Built-in chat interface -- always available at /chat
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

      {/* Available (unconfigured) channels */}
      {unconfiguredChannels.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">Available Channels</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {unconfiguredChannels.map((ch) => (
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

      <div className="rounded-md bg-secondary/20 p-3">
        <p className="text-xs text-muted-foreground">
          You can configure additional channels from the Channels page after completing setup.
        </p>
      </div>
    </div>
  );
}
