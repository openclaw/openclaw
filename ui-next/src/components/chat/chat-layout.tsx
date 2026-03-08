import { Menu } from "lucide-react";
import { useState, useCallback, type ReactNode } from "react";
import { SessionSidebarContent } from "@/components/chat/chat-sidebar";
import {
  ContextPanel,
  ContextPanelSheet,
  type ContextPanelContent,
} from "@/components/chat/context-panel";
import { Button } from "@/components/ui/button";
import type { ModelEntry } from "@/components/ui/custom/status/model-selector";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { loadSettings, saveSettings } from "@/lib/storage";
import { cn } from "@/lib/utils";

export type ChatLayoutProps = {
  /** Sidebar action handlers */
  switchSession: (key: string) => void;
  activeSessionKey: string;
  onNewChat: () => void;
  resetSession: (key: string) => void;
  handleDeleteSession: (key: string) => void;
  handleRenameSession: (key: string, newLabel: string) => void;
  handleArchiveSidebar: (key: string, archive: boolean) => Promise<void>;
  /** Main content area */
  children: ReactNode;
  /** Context panel state */
  contextPanel: { open: boolean; content: ContextPanelContent | null };
  onCloseContextPanel: () => void;
  /** Available models for context window lookup */
  models?: ModelEntry[];
};

export function ChatLayout({
  switchSession,
  activeSessionKey,
  onNewChat,
  resetSession,
  handleDeleteSession,
  handleRenameSession,
  handleArchiveSidebar,
  children,
  contextPanel,
  onCloseContextPanel,
  models,
}: ChatLayoutProps) {
  const [chatSidebarCollapsed, setChatSidebarCollapsedRaw] = useState(
    () => loadSettings().chatSidebarCollapsed,
  );
  const setChatSidebarCollapsed = useCallback((collapsed: boolean) => {
    setChatSidebarCollapsedRaw(collapsed);
    const s = loadSettings();
    s.chatSidebarCollapsed = collapsed;
    saveSettings(s);
  }, []);

  const isMobile = useIsMobile();

  return (
    <div className="flex h-full bg-background overflow-hidden">
      {/* Desktop Sidebar */}
      <div
        className={cn(
          "hidden md:block border-r border-border h-full shrink-0 transition-all duration-200 ease-in-out overflow-hidden",
          chatSidebarCollapsed ? "w-[52px]" : "w-80",
        )}
      >
        <SessionSidebarContent
          onSelect={switchSession}
          activeKey={activeSessionKey}
          onNewChat={onNewChat}
          onReset={resetSession}
          onDelete={handleDeleteSession}
          onRename={handleRenameSession}
          onArchive={handleArchiveSidebar}
          collapsed={chatSidebarCollapsed}
          onCollapse={setChatSidebarCollapsed}
          models={models}
        />
      </div>

      {/* Main chat area */}
      <div className="flex flex-1 flex-col min-w-0 h-full relative">
        {/* Header - Mobile Sidebar Trigger Only */}
        <div className="md:hidden flex items-center border-b border-border px-4 py-2 h-14 shrink-0 bg-background/80 backdrop-blur z-20 absolute top-0 left-0 right-0">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="-ml-2" aria-label="Open chat sidebar">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-80 border-r border-border">
              <SessionSidebarContent
                onSelect={switchSession}
                activeKey={activeSessionKey}
                onNewChat={onNewChat}
                onReset={resetSession}
                onDelete={handleDeleteSession}
                onRename={handleRenameSession}
                onArchive={handleArchiveSidebar}
              />
            </SheetContent>
          </Sheet>
          <span className="font-medium ml-2">Chat</span>
        </div>

        {/* Content area */}
        {children}
      </div>

      {/* Desktop: inline resizable context panel */}
      {!isMobile && (
        <ContextPanel
          open={contextPanel.open}
          panelContent={contextPanel.content}
          onClose={onCloseContextPanel}
        />
      )}

      {/* Mobile: context panel as Sheet overlay */}
      {isMobile && (
        <ContextPanelSheet
          open={contextPanel.open}
          panelContent={contextPanel.content}
          onClose={onCloseContextPanel}
        />
      )}
    </div>
  );
}
