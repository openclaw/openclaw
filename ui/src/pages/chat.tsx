import { useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAgentChat, useRPC } from "@/hooks";
import { useSessionsStore } from "@/stores/sessions";
import { ChatMessage } from "@/components/shared/chat-message";
import { ChatInput } from "@/components/shared/chat-input";
import { SessionSidebar } from "@/components/shared/session-sidebar";

export function ChatPage() {
  const rpc = useRPC();
  const activeSessionKey = useSessionsStore((s) => s.activeSessionKey);
  const { messages, isStreaming, sendMessage, abort } =
    useAgentChat(activeSessionKey);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="flex flex-col h-[calc(100vh-theme(spacing.12)-theme(spacing.8))]">
      <div className="flex items-center gap-2 mb-4">
        <SessionSidebar trigger={<Button variant="outline">Sessions</Button>} />
        <h1 className="text-2xl font-bold">Chat</h1>
        {activeSessionKey && (
          <>
            <span className="text-sm text-muted-foreground">
              Session: {activeSessionKey.slice(0, 8)}
            </span>
            <Popover>
              <PopoverTrigger
                render={
                  <Button variant="ghost" size="sm">
                    Settings
                  </Button>
                }
              />
              <PopoverContent className="w-64 space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Thinking Level</label>
                  <Select
                    onValueChange={(v) =>
                      rpc("sessions.patch", {
                        key: activeSessionKey,
                        thinkingLevel: v,
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Fast Mode</label>
                  <Switch
                    onCheckedChange={(v) =>
                      rpc("sessions.patch", {
                        key: activeSessionKey,
                        fastMode: v,
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Verbose Level</label>
                  <Select
                    onValueChange={(v) =>
                      rpc("sessions.patch", {
                        key: activeSessionKey,
                        verboseLevel: v,
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="quiet">Quiet</SelectItem>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="verbose">Verbose</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </PopoverContent>
            </Popover>
          </>
        )}
      </div>

      {!activeSessionKey ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          Select or create a session to start chatting
        </div>
      ) : (
        <>
          <ScrollArea className="flex-1 mb-4">
            <div className="space-y-4 pr-4">
              {messages.length === 0 && (
                <div className="space-y-4">
                  <Skeleton className="h-20 w-3/4" />
                  <Skeleton className="h-20 w-1/2 ml-auto" />
                </div>
              )}
              {messages.map((msg) => (
                <ChatMessage key={msg.id} message={msg} />
              ))}
              <div ref={scrollRef} />
            </div>
          </ScrollArea>
          <ChatInput
            onSend={sendMessage}
            onAbort={abort}
            isStreaming={isStreaming}
          />
        </>
      )}
    </div>
  );
}
