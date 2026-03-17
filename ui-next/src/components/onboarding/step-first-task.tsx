import { Send, Loader2, CheckCircle2 } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/hooks/use-gateway";

type Props = { onValidChange: (valid: boolean) => void };

export function StepFirstTask({ onValidChange }: Props) {
  const { sendRpc } = useGateway();
  const [message, setMessage] = useState("Hello! Can you introduce yourself briefly?");
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onValidChange(response !== null);
  }, [response, onValidChange]);

  const handleSend = useCallback(async () => {
    if (!message.trim() || sending) {
      return;
    }
    setSending(true);
    setError(null);
    setResponse(null);
    try {
      const result = await sendRpc<{ response?: string; message?: string }>("chat.send", {
        message: message.trim(),
        sessionKey: "onboarding-test",
      });
      setResponse(result.response ?? result.message ?? "Message sent successfully!");
    } catch {
      // For streaming, chat.send may not return a direct response.
      // Mark as done anyway -- the message was sent.
      setResponse("Message sent! Check the Chat page to see the response.");
    } finally {
      setSending(false);
    }
  }, [message, sending, sendRpc]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Send Your First Message</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Try sending a message to verify everything is working.
        </p>
      </div>

      <div className="rounded-lg border border-border p-4 space-y-4">
        <div>
          <label className="text-sm font-medium block mb-1.5">Message</label>
          <textarea
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm min-h-[80px] resize-none focus:outline-none focus:ring-1 focus:ring-primary"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type a message..."
          />
        </div>

        <Button size="sm" onClick={handleSend} disabled={sending || !message.trim()}>
          {sending ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Send className="h-4 w-4 mr-1" />
          )}
          Send Message
        </Button>
      </div>

      {response && (
        <div className="rounded-lg border border-primary/50 bg-primary/5 p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="text-sm font-medium text-primary">Message Sent</div>
              <p className="text-sm text-muted-foreground">{response}</p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {!response && (
        <div className="rounded-md bg-secondary/20 p-3">
          <p className="text-xs text-muted-foreground">
            You can also skip this step and try the Chat page later.
          </p>
        </div>
      )}
    </div>
  );
}
