"use client";

import { useState } from "react";
import {
  saveSupabaseInstance,
  testSupabaseConnection,
  type SupabaseInstanceConfig,
} from "@/lib/supabase-config";
import { useGateway } from "@/lib/use-gateway";

interface SupabaseProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (profileName: string) => void;
}

export function SupabaseProfileModal({ isOpen, onClose, onSave }: SupabaseProfileModalProps) {
  const { request } = useGateway();
  const [formData, setFormData] = useState({
    name: "",
    url: "",
    key: "",
    schema: "public",
  });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  if (!isOpen) {
    return null;
  }

  const handleTest = async () => {
    if (!formData.url || !formData.key) {
      setTestResult({ success: false, message: "Please fill in URL and Key" });
      return;
    }

    setTesting(true);
    setTestResult(null);

    try {
      const result = await testSupabaseConnection(request, {
        id: formData.name || "test",
        name: formData.name || "test",
        url: formData.url,
        key: formData.key,
        schema: formData.schema,
      });
      setTestResult(result);
    } catch (error) {
      setTestResult({
        success: false,
        message: error instanceof Error ? error.message : "Connection failed",
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!formData.name || !formData.url || !formData.key) {
      alert("Please fill in all required fields");
      return;
    }

    setSaving(true);

    try {
      await saveSupabaseInstance(request, {
        id: formData.name,
        name: formData.name,
        url: formData.url,
        key: formData.key,
        schema: formData.schema,
      });
      onSave(formData.name);
      handleClose();
    } catch (error) {
      alert("Failed to save profile: " + (error instanceof Error ? error.message : "Unknown error"));
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setFormData({ name: "", url: "", key: "", schema: "public" });
    setTestResult(null);
    onClose();
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0, 0, 0, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={handleClose}
    >
      <div
        style={{
          background: "var(--bg)",
          borderRadius: "var(--radius-lg)",
          padding: 24,
          width: "100%",
          maxWidth: 480,
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "0 8px 32px rgba(0, 0, 0, 0.3)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 20, color: "var(--text-strong)" }}>
          ➕ Add New Supabase Profile
        </h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 6, color: "var(--muted)" }}>
              Profile Name *
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="my-project, production, staging..."
              style={{
                width: "100%",
                height: 36,
                padding: "0 12px",
                fontSize: 13,
                borderWidth: 1,
                borderStyle: "solid",
                borderColor: "var(--border)",
                borderRadius: "var(--radius-md)",
                background: "var(--card)",
                color: "var(--text-strong)",
                outline: "none",
              }}
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 6, color: "var(--muted)" }}>
              Project URL *
            </label>
            <input
              type="url"
              value={formData.url}
              onChange={(e) => setFormData({ ...formData, url: e.target.value })}
              placeholder="https://xxxxx.supabase.co"
              style={{
                width: "100%",
                height: 36,
                padding: "0 12px",
                fontSize: 13,
                borderWidth: 1,
                borderStyle: "solid",
                borderColor: "var(--border)",
                borderRadius: "var(--radius-md)",
                background: "var(--card)",
                color: "var(--text-strong)",
                outline: "none",
              }}
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 6, color: "var(--muted)" }}>
              Service Role Key *
            </label>
            <input
              type="password"
              value={formData.key}
              onChange={(e) => setFormData({ ...formData, key: e.target.value })}
              placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
              style={{
                width: "100%",
                height: 36,
                padding: "0 12px",
                fontSize: 13,
                borderWidth: 1,
                borderStyle: "solid",
                borderColor: "var(--border)",
                borderRadius: "var(--radius-md)",
                background: "var(--card)",
                color: "var(--text-strong)",
                outline: "none",
              }}
            />
            <p style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>
              ⚠️ Use service_role key (not anon key) for backend operations
            </p>
          </div>

          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 6, color: "var(--muted)" }}>
              Schema
            </label>
            <input
              type="text"
              value={formData.schema}
              onChange={(e) => setFormData({ ...formData, schema: e.target.value })}
              placeholder="public"
              style={{
                width: "100%",
                height: 36,
                padding: "0 12px",
                fontSize: 13,
                borderWidth: 1,
                borderStyle: "solid",
                borderColor: "var(--border)",
                borderRadius: "var(--radius-md)",
                background: "var(--card)",
                color: "var(--text-strong)",
                outline: "none",
              }}
            />
          </div>

          {testResult && (
            <div
              style={{
                padding: 12,
                borderRadius: "var(--radius-md)",
                fontSize: 12,
                background: testResult.success ? "var(--success-subtle)" : "var(--danger-subtle)",
                color: testResult.success ? "var(--success)" : "var(--danger)",
              }}
            >
              {testResult.success ? "✅ " : "❌ "}
              {testResult.message}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, paddingTop: 8 }}>
            <button
              onClick={handleTest}
              disabled={testing || !formData.url || !formData.key}
              style={{
                flex: 1,
                height: 36,
                padding: "0 16px",
                fontSize: 13,
                fontWeight: 500,
                borderWidth: 1,
                borderStyle: "solid",
                borderColor: "var(--border)",
                borderRadius: "var(--radius-md)",
                background: testing ? "var(--muted)" : "transparent",
                color: "var(--text)",
                cursor: testing ? "not-allowed" : "pointer",
                opacity: testing ? 0.6 : 1,
              }}
            >
              {testing ? "Testing..." : "Test Connection"}
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !formData.name || !formData.url || !formData.key}
              style={{
                flex: 1,
                height: 36,
                padding: "0 16px",
                fontSize: 13,
                fontWeight: 500,
                borderWidth: 0,
                borderRadius: "var(--radius-md)",
                background: saving || !formData.name || !formData.url || !formData.key
                  ? "var(--muted)"
                  : "var(--primary)",
                color: saving || !formData.name || !formData.url || !formData.key
                  ? "var(--muted)"
                  : "var(--primary-foreground)",
                cursor: saving || !formData.name || !formData.url || !formData.key ? "not-allowed" : "pointer",
                opacity: saving || !formData.name || !formData.url || !formData.key ? 0.6 : 1,
              }}
            >
              {saving ? "Saving..." : "Save & Select"}
            </button>
            <button
              onClick={handleClose}
              style={{
                height: 36,
                padding: "0 16px",
                fontSize: 13,
                fontWeight: 500,
                borderWidth: 1,
                borderStyle: "solid",
                borderColor: "var(--border)",
                borderRadius: "var(--radius-md)",
                background: "transparent",
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
