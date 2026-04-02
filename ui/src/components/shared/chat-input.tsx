import { useState, type KeyboardEvent } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

interface ChatInputProps {
  onSend: (message: string) => void;
  onAbort: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

export function ChatInput({
  onSend,
  onAbort,
  isStreaming,
  disabled,
}: ChatInputProps) {
  const [input, setInput] = useState("");

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setInput("");
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex gap-2 items-end">
      <Textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a message..."
        className="min-h-[80px] resize-none"
        disabled={disabled}
      />
      {isStreaming ? (
        <Button variant="destructive" onClick={onAbort}>
          Stop
        </Button>
      ) : (
        <Button onClick={handleSend} disabled={!input.trim() || disabled}>
          Send
        </Button>
      )}
    </div>
  );
}
