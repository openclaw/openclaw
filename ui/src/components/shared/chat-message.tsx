import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage as ChatMessageType } from "@/stores/chat";

interface ChatMessageProps {
  message: ChatMessageType;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const roleVariant = {
    user: "default" as const,
    assistant: "secondary" as const,
    tool: "outline" as const,
    system: "destructive" as const,
  };

  return (
    <Card className={message.role === "user" ? "ml-12" : "mr-12"}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <Badge variant={roleVariant[message.role]}>{message.role}</Badge>
          <span className="text-xs text-muted-foreground">
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
          {message.isStreaming && (
            <span className="text-xs text-muted-foreground animate-pulse">
              typing...
            </span>
          )}
        </div>
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content}
          </ReactMarkdown>
        </div>
        {message.toolCalls && message.toolCalls.length > 0 && (
          <Accordion multiple className="mt-2">
            {message.toolCalls.map((tool, i) => (
              <AccordionItem key={i} value={`tool-${i}`}>
                <AccordionTrigger className="text-sm">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{tool.name}</Badge>
                    <Badge
                      variant={
                        tool.status === "running"
                          ? "default"
                          : tool.status === "completed"
                            ? "secondary"
                            : "destructive"
                      }
                    >
                      {tool.status}
                    </Badge>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <pre className="text-xs bg-muted p-2 rounded overflow-auto">
                    {JSON.stringify(tool.params, null, 2)}
                  </pre>
                  {tool.output && (
                    <pre className="text-xs bg-muted p-2 rounded overflow-auto mt-2">
                      {tool.output}
                    </pre>
                  )}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </CardContent>
    </Card>
  );
}
