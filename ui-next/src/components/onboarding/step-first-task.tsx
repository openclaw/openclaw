import { Send, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/hooks/use-gateway";
import { useChatStore } from "@/store/chat-store";

type Props = { onValidChange: (valid: boolean) => void };

const ONBOARDING_SESSION_KEY = "agent:main:onboarding-test";

type AgentSummary = {
  agentId: string;
  name?: string;
};

export function StepFirstTask({ onValidChange }: Props) {
  const { sendRpc } = useGateway();
  const [message, setMessage] = useState("Hello! Can you introduce yourself briefly?");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedAgent, setSelectedAgent] = useState("");

  // Subscribe to streaming state for the onboarding session
  const streamState = useChatStore((s) => s.getSessionState(ONBOARDING_SESSION_KEY));
  const { isStreaming, streamContent } = streamState;

  // Load agents for the selector
  useEffect(() => {
    const load = async () => {
      try {
        const result = await sendRpc<{ agents: AgentSummary[] }>("agents.list", {});
        const list = result.agents ?? [];
        setAgents(list);
        if (list.length > 0 && !selectedAgent) {
          setSelectedAgent(list[0].agentId);
        }
      } catch {
        // No agents available
      }
    };
    void load();
  }, [sendRpc, selectedAgent]);

  // Mark valid when response is finalized (not still streaming)
  useEffect(() => {
    onValidChange(sent && !isStreaming && streamContent.length > 0);
  }, [sent, isStreaming, streamContent, onValidChange]);

  const handleSend = useCallback(async () => {
    if (!message.trim() || sending) {
      return;
    }
    setSending(true);
    setError(null);
    setSent(false);

    try {
      const params: Record<string, string> = {
        message: message.trim(),
        sessionKey: ONBOARDING_SESSION_KEY,
        idempotencyKey: crypto.randomUUID(),
      };
      if (selectedAgent) {
        params.agentId = selectedAgent;
      }

      const result = await sendRpc<{ runId?: string }>("chat.send", params);

      // Arm the stream if the gateway returned a runId
      if (result?.runId) {
        const store = useChatStore.getState();
        const sessState = store.getSessionState(ONBOARDING_SESSION_KEY);
        if (!sessState.streamRunId && !sessState.isStreaming) {
          store.startStream(result.runId, ONBOARDING_SESSION_KEY);
        }
      }

      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }, [message, sending, selectedAgent, sendRpc]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Send Your First Message</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Try sending a message to verify everything is working.
        </p>
      </div>

      <div className="rounded-lg border border-border p-4 space-y-4">
        {/* Agent selector */}
        {agents.length > 1 && (
          <div>
            <label className="text-sm font-medium block mb-1.5">Agent</label>
            <select
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={selectedAgent}
              onChange={(e) => setSelectedAgent(e.target.value)}
            >
              {agents.map((a, i) => (
                <option key={a.agentId ?? `agent-${i}`} value={a.agentId}>
                  {a.name ?? a.agentId}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Message input */}
        <div>
          <label className="text-sm font-medium block mb-1.5">Message</label>
          <textarea
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm min-h-[80px] resize-none focus:outline-none focus:ring-1 focus:ring-primary"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type a message..."
            disabled={sending || isStreaming}
          />
        </div>

        <Button size="sm" onClick={handleSend} disabled={sending || isStreaming || !message.trim()}>
          {sending ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Send className="h-4 w-4 mr-1" />
          )}
          Send Message
        </Button>
      </div>

      {/* Streaming response */}
      {(isStreaming || (sent && streamContent)) && (
        <div className="rounded-lg border border-border p-4 space-y-2">
          <div className="flex items-center gap-2">
            {isStreaming ? (
              <Loader2 className="h-4 w-4 text-primary animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-primary" />
            )}
            <span className="text-sm font-medium">
              {isStreaming ? "Agent responding..." : "Response received"}
            </span>
          </div>
          <div className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
            {streamContent || "Thinking..."}
          </div>
        </div>
      )}

      {/* Sent but no stream content yet (gateway may not support streaming for this session) */}
      {sent && !isStreaming && !streamContent && !error && (
        <div className="rounded-lg border border-primary/50 bg-primary/5 p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="text-sm font-medium text-primary">Message Sent</div>
              <p className="text-sm text-muted-foreground">
                Message sent! Check the Chat page to see the response.
              </p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        </div>
      )}

      {!sent && !sending && (
        <div className="rounded-md bg-secondary/20 p-3">
          <p className="text-xs text-muted-foreground">
            You can also skip this step and try the Chat page later.
          </p>
        </div>
      )}
    </div>
  );
}
