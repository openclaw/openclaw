import { Settings, RotateCcw, Save, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { ConfigDiffBanner } from "@/components/config/config-diff-banner";
import { ConfigFormView } from "@/components/config/config-form-view";
import { ConfigSidebar } from "@/components/config/config-sidebar";
import { Button } from "@/components/ui/button";
import { ConfigEditor } from "@/components/ui/custom/form";
import { useGateway } from "@/hooks/use-gateway";
import { setPathValue, removePathValue } from "@/lib/config-form-utils";
import { normalizeSchemaNode } from "@/lib/config-schema";
import { loadSettings, saveSettings } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { useGatewayStore } from "@/store/gateway-store";
import type { JsonSchema, ConfigUiHints, ConfigSchemaResponse } from "@/types/agents";

type ConfigResult = {
  config?: Record<string, unknown>;
  raw?: string;
  hash?: string;
  path?: string;
  valid?: boolean;
};

export function ConfigPage() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");

  // Config data state
  const [configRaw, setConfigRaw] = useState("");
  const [baseHash, setBaseHash] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [configValid, setConfigValid] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  // Raw mode state
  const [editValue, setEditValue] = useState("");

  // Form mode state
  const [formValue, setFormValue] = useState<Record<string, unknown> | null>(null);
  const [originalValue, setOriginalValue] = useState<Record<string, unknown> | null>(null);

  // Schema state
  const [normalizedSchema, setNormalizedSchema] = useState<JsonSchema | null>(null);
  const [hints, setHints] = useState<ConfigUiHints>({});
  const [schemaLoading, setSchemaLoading] = useState(false);

  // UI state
  const [formMode, setFormMode] = useState<"form" | "raw">("form");
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarCollapsed, setSidebarCollapsedRaw] = useState(
    () => loadSettings().configSidebarCollapsed,
  );
  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsedRaw(collapsed);
    const s = loadSettings();
    s.configSidebarCollapsed = collapsed;
    saveSettings(s);
  }, []);

  // Load config data
  const loadConfig = useCallback(async () => {
    setLoading(true);
    setSaveResult(null);
    try {
      const result = await sendRpc<ConfigResult>("config.get", {});
      const raw = result?.raw ?? JSON.stringify(result?.config ?? {}, null, 2);
      setConfigRaw(raw);
      setEditValue(raw);
      setBaseHash(result?.hash ?? "");
      setConfigPath(result?.path ?? "");
      setConfigValid(result?.valid ?? null);

      // Parse into form value
      const parsed = result?.config ?? (result?.raw ? JSON.parse(result.raw) : {});
      const obj = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
        string,
        unknown
      >;
      setFormValue(structuredClone(obj));
      setOriginalValue(structuredClone(obj));
    } catch (e) {
      setSaveResult({ ok: false, message: `Failed to load: ${(e as Error).message}` });
    } finally {
      setLoading(false);
    }
  }, [sendRpc]);

  // Load config schema
  const loadSchema = useCallback(async () => {
    setSchemaLoading(true);
    try {
      const result = await sendRpc<ConfigSchemaResponse>("config.schema", {});
      if (result?.schema) {
        const { schema: norm } = normalizeSchemaNode(result.schema);
        setNormalizedSchema(norm);
      }
      if (result?.uiHints) {
        setHints(result.uiHints);
      }
    } catch {
      // Schema is optional — form will degrade gracefully to raw mode
    } finally {
      setSchemaLoading(false);
    }
  }, [sendRpc]);

  useEffect(() => {
    if (isConnected) {
      void loadConfig();
      void loadSchema();
    }
  }, [isConnected, loadConfig, loadSchema]);

  // Form patch handler
  const handlePatch = useCallback((path: Array<string | number>, value: unknown) => {
    setFormValue((prev) => {
      if (!prev) {
        return prev;
      }
      return setPathValue(prev, path, value);
    });
  }, []);

  // Form remove handler (for additionalProperties)
  const handleRemove = useCallback((path: Array<string | number>) => {
    setFormValue((prev) => {
      if (!prev) {
        return prev;
      }
      return removePathValue(prev, path);
    });
  }, []);

  // Save handler
  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveResult(null);
    try {
      // Get the raw value to save
      let rawToSave: string;
      if (formMode === "form" && formValue) {
        rawToSave = JSON.stringify(formValue, null, 2);
      } else {
        rawToSave = editValue;
      }

      // Validate JSON
      JSON.parse(rawToSave);

      const result = await sendRpc<{ ok?: boolean; restart?: boolean }>("config.apply", {
        raw: rawToSave,
        baseHash,
        note: "Updated via control UI",
        restartDelayMs: 1500,
      });

      if (result?.ok) {
        setSaveResult({
          ok: true,
          message: result.restart
            ? "Config saved. Gateway restarting..."
            : "Config saved successfully",
        });
        setTimeout(() => loadConfig(), result.restart ? 3000 : 500);
      } else {
        setSaveResult({ ok: false, message: "Save failed" });
      }
    } catch (e) {
      setSaveResult({ ok: false, message: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [editValue, formValue, formMode, baseHash, sendRpc, loadConfig]);

  // Mode switching
  const handleFormModeChange = useCallback(
    (mode: "form" | "raw") => {
      if (mode === formMode) {
        return;
      }

      if (mode === "raw" && formValue) {
        // Form → Raw: serialize form state
        const serialized = JSON.stringify(formValue, null, 2);
        setEditValue(serialized);
      } else if (mode === "form" && editValue) {
        // Raw → Form: parse raw
        try {
          const parsed = JSON.parse(editValue) as Record<string, unknown>;
          setFormValue(parsed);
        } catch {
          // If JSON is invalid, stay in raw mode
          setSaveResult({ ok: false, message: "Invalid JSON — cannot switch to Form view" });
          return;
        }
      }

      setFormMode(mode);
    },
    [formMode, formValue, editValue],
  );

  // Dirty state detection
  const isDirty =
    formMode === "form"
      ? JSON.stringify(formValue) !== JSON.stringify(originalValue)
      : editValue !== configRaw;

  // JSON validation for raw mode
  let jsonValid = true;
  if (formMode === "raw") {
    try {
      if (editValue) {
        JSON.parse(editValue);
      }
    } catch {
      jsonValid = false;
    }
  }

  // Available sections: union of config data keys + schema property keys
  const availableSections = (() => {
    const keys = new Set<string>();
    if (formValue) {
      Object.keys(formValue).forEach((k) => keys.add(k));
    }
    if (normalizedSchema?.properties) {
      Object.keys(normalizedSchema.properties).forEach((k) => keys.add(k));
    }
    return Array.from(keys);
  })();

  // Can we show the form view?
  const canShowForm = normalizedSchema !== null && formValue !== null;

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-1 pb-4">
        <div className="flex items-center gap-3">
          <Settings className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Config</h1>
          {configPath && (
            <span className="text-xs font-mono text-muted-foreground">{configPath}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadConfig} disabled={loading}>
            <RotateCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            Reload
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleSave}
            disabled={!isDirty || (formMode === "raw" && !jsonValid) || saving}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save & Apply
          </Button>
        </div>
      </div>

      {/* Save result banner */}
      {saveResult && (
        <div
          className={cn(
            "rounded-lg border px-4 py-3 text-sm flex items-center gap-2 mb-4",
            saveResult.ok
              ? "border-chart-2/30 bg-chart-2/5 text-chart-2"
              : "border-destructive/30 bg-destructive/5 text-destructive",
          )}
        >
          {saveResult.ok ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="h-4 w-4 shrink-0" />
          )}
          {saveResult.message}
        </div>
      )}

      {!isConnected ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground">
          <Settings className="h-8 w-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Connect to the gateway to edit configuration</p>
        </div>
      ) : loading || schemaLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="flex-1 flex gap-0 min-h-0 rounded-lg border border-border overflow-hidden">
          {/* Sidebar */}
          <div
            className={cn(
              "shrink-0 border-r border-border bg-muted/10 transition-all duration-200 ease-in-out h-full overflow-hidden",
              sidebarCollapsed ? "w-[52px]" : "w-[240px]",
            )}
          >
            <ConfigSidebar
              activeSection={activeSection}
              onSectionChange={setActiveSection}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              formMode={canShowForm ? formMode : "raw"}
              onFormModeChange={canShowForm ? handleFormModeChange : () => {}}
              isValid={configValid}
              availableSections={availableSections}
              collapsed={sidebarCollapsed}
              onCollapse={setSidebarCollapsed}
            />
          </div>

          {/* Main content */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {/* Diff banner (form mode only) */}
            {formMode === "form" && formValue && originalValue && (
              <ConfigDiffBanner formValue={formValue} originalValue={originalValue} />
            )}

            {/* Raw mode unsaved warning */}
            {formMode === "raw" && isDirty && (
              <div className="flex items-center gap-2 text-xs font-mono text-chart-5">
                <AlertTriangle className="h-3.5 w-3.5" />
                Unsaved changes. Saving will apply changes and may restart the gateway.
              </div>
            )}

            {/* Form view */}
            {formMode === "form" && canShowForm && formValue ? (
              <ConfigFormView
                schema={normalizedSchema}
                formValue={formValue}
                hints={hints}
                activeSection={activeSection}
                searchQuery={searchQuery}
                onPatch={handlePatch}
                onRemove={handleRemove}
              />
            ) : (
              /* Raw view */
              <ConfigEditor
                value={configRaw}
                onChange={setEditValue}
                onSave={handleSave}
                language="json"
                className="min-h-[500px]"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
