import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useSessionsStore } from "@/stores/sessions";
import { useRPC } from "@/hooks";

interface SessionSidebarProps {
  trigger: React.ReactElement;
}

export function SessionSidebar({ trigger }: SessionSidebarProps) {
  const { sessions, activeSessionKey, setActiveSessionKey } =
    useSessionsStore();
  const rpc = useRPC();

  const createSession = async () => {
    const result = await rpc<{ key: string }>("sessions.create", {});
    setActiveSessionKey(result.key);
  };

  const deleteSession = async (key: string) => {
    await rpc("sessions.delete", { key, deleteTranscript: false });
  };

  return (
    <Sheet>
      <SheetTrigger render={trigger} />
      <SheetContent side="left">
        <SheetHeader>
          <SheetTitle>Sessions</SheetTitle>
        </SheetHeader>
        <div className="mt-4">
          <Button onClick={createSession} className="w-full mb-4">
            New Session
          </Button>
          <ScrollArea className="h-[calc(100vh-200px)]">
            <div className="space-y-2">
              {sessions.map((session) => (
                <div
                  key={session.key}
                  className={`flex items-center justify-between p-2 rounded cursor-pointer hover:bg-accent ${
                    activeSessionKey === session.key ? "bg-accent" : ""
                  }`}
                  onClick={() => setActiveSessionKey(session.key)}
                >
                  <span className="text-sm truncate">
                    {session.label ?? session.key.slice(0, 8)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteSession(session.key);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
}
