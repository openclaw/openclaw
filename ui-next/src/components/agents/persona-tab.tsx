import { FileText, Loader2, Save, Pencil, X, Plus } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfigEditor } from "@/components/ui/custom/form";
import { Markdown } from "@/components/ui/custom/prompt/markdown";
import type { AgentFileGetResult, AgentFileSetResult } from "@/types/agents";

type PersonaFileProps = {
  label: string;
  fileName: string;
  agentId: string;
  getAgentFile: (agentId: string, name: string) => Promise<AgentFileGetResult | undefined>;
  setAgentFile: (
    agentId: string,
    name: string,
    content: string,
  ) => Promise<AgentFileSetResult | undefined>;
};

function PersonaFile({ label, fileName, agentId, getAgentFile, setAgentFile }: PersonaFileProps) {
  const [content, setContent] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [missing, setMissing] = useState(false);

  const loadFile = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getAgentFile(agentId, fileName);
      if (result?.file?.missing) {
        setMissing(true);
        setContent(null);
        setOriginalContent("");
      } else if (result?.file?.content !== undefined) {
        setMissing(false);
        setContent(result.file.content);
        setOriginalContent(result.file.content);
        setEditContent(result.file.content);
      } else {
        setMissing(true);
        setContent(null);
        setOriginalContent("");
      }
    } catch {
      setMissing(true);
      setContent(null);
    } finally {
      setLoading(false);
    }
  }, [agentId, fileName, getAgentFile]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await setAgentFile(agentId, fileName, editContent);
      setContent(editContent);
      setOriginalContent(editContent);
      setMissing(false);
      setEditing(false);
    } catch (e) {
      console.error(`Failed to save ${fileName}`, e);
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = () => {
    setMissing(false);
    setContent("");
    setEditContent("");
    setOriginalContent("");
    setEditing(true);
  };

  const handleCancel = () => {
    if (originalContent === "" && content === null) {
      // Was a new file creation that got cancelled
      setMissing(true);
      setContent(null);
    }
    setEditContent(originalContent);
    setEditing(false);
  };

  const isDirty = editContent !== originalContent;

  return (
    <div className="rounded-lg border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/20">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-mono font-medium">{fileName}</span>
          <span className="text-xs text-muted-foreground">{label}</span>
          {editing && isDirty && (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 text-chart-5 border-chart-5/30"
            >
              modified
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {!missing && !editing && content !== null && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={() => {
                setEditContent(content);
                setEditing(true);
              }}
            >
              <Pencil className="h-3 w-3 mr-1.5" />
              Edit
            </Button>
          )}
          {editing && (
            <>
              <Button variant="ghost" size="sm" className="h-7" onClick={handleCancel}>
                <X className="h-3 w-3 mr-1.5" />
                Cancel
              </Button>
              <Button size="sm" className="h-7" onClick={handleSave} disabled={saving || !isDirty}>
                {saving ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                ) : (
                  <Save className="h-3 w-3 mr-1.5" />
                )}
                Save
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="p-4">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : missing ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <FileText className="h-8 w-8 mb-3 opacity-20" />
            <p className="text-sm mb-3">No {fileName} found for this agent.</p>
            <Button variant="outline" size="sm" onClick={handleCreate}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Create {fileName}
            </Button>
          </div>
        ) : editing ? (
          <ConfigEditor
            value={editContent}
            onChange={setEditContent}
            language="markdown"
            className="border-0"
          />
        ) : content ? (
          <div className="prose-sm max-w-none">
            <Markdown>{content}</Markdown>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">Empty file.</p>
        )}
      </div>
    </div>
  );
}

export function PersonaTab({
  agentId,
  getAgentFile,
  setAgentFile,
}: {
  agentId: string;
  getAgentFile: (agentId: string, name: string) => Promise<AgentFileGetResult | undefined>;
  setAgentFile: (
    agentId: string,
    name: string,
    content: string,
  ) => Promise<AgentFileSetResult | undefined>;
}) {
  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h3 className="text-lg font-semibold mb-1">Persona</h3>
        <p className="text-sm text-muted-foreground">
          SOUL.md defines the agent's personality and behavioral guidelines. IDENTITY.md provides
          identity metadata and context.
        </p>
      </div>

      <PersonaFile
        label="Personality & behavior"
        fileName="SOUL.md"
        agentId={agentId}
        getAgentFile={getAgentFile}
        setAgentFile={setAgentFile}
      />

      <PersonaFile
        label="Identity & context"
        fileName="IDENTITY.md"
        agentId={agentId}
        getAgentFile={getAgentFile}
        setAgentFile={setAgentFile}
      />
    </div>
  );
}
