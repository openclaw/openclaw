"use client";

import { useState, useEffect } from "react";
import { getSupabaseInstances, type SupabaseInstanceConfig } from "@/lib/supabase-config";
import { SupabaseProfileModal } from "./supabase-profile-modal";
import { useGateway } from "@/lib/use-gateway";

interface SupabaseProfileSelectorProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}

export function SupabaseProfileSelector({ value, onChange, label = "Supabase Profile" }: SupabaseProfileSelectorProps) {
  const { request } = useGateway();
  const [profiles, setProfiles] = useState<SupabaseInstanceConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    loadProfiles();
  }, []);

  const loadProfiles = async () => {
    setLoading(true);
    try {
      const instances = await getSupabaseInstances(request);
      setProfiles(instances);
    } catch (error) {
      console.error("Failed to load profiles:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleNewProfile = () => {
    setShowModal(true);
    setIsOpen(false);
  };

  const handleProfileSaved = (profileName: string) => {
    onChange(profileName);
    loadProfiles();
  };

  const currentProfile = profiles.find((p) => p.id === value);

  return (
    <>
      <div style={{ position: "relative" }}>
        {label && (
          <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 6, color: "var(--muted)" }}>
            {label}
          </label>
        )}
        
        <div style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => setIsOpen(!isOpen)}
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
              color: value ? "var(--text-strong)" : "var(--muted)",
              outline: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {loading ? (
                <span>Loading...</span>
              ) : currentProfile ? (
                <>
                  <span>🗄️</span>
                  <span>{currentProfile.name}</span>
                  {currentProfile.isDefault && (
                    <span
                      style={{
                        fontSize: 10,
                        padding: "2px 6px",
                        background: "var(--primary)",
                        color: "var(--primary-foreground)",
                        borderRadius: 4,
                      }}
                    >
                      Default
                    </span>
                  )}
                </>
              ) : (
                <span>Select a profile...</span>
              )}
            </span>
            <span style={{ fontSize: 10, color: "var(--muted)" }}>{isOpen ? "▲" : "▼"}</span>
          </button>

          {isOpen && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                right: 0,
                marginTop: 4,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
                boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
                zIndex: 100,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  maxHeight: 240,
                  overflowY: "auto",
                  padding: 4,
                }}
              >
                {profiles.length === 0 ? (
                  <div
                    style={{
                      padding: "8px 12px",
                      fontSize: 12,
                      color: "var(--muted)",
                      textAlign: "center",
                    }}
                  >
                    No profiles configured
                  </div>
                ) : (
                  profiles.map((profile) => (
                    <button
                      key={profile.id}
                      type="button"
                      onClick={() => {
                        onChange(profile.id);
                        setIsOpen(false);
                      }}
                      style={{
                        width: "100%",
                        padding: "8px 12px",
                        fontSize: 13,
                        textAlign: "left",
                        borderWidth: 0,
                        background: profile.id === value ? "var(--bg-hover)" : "transparent",
                        color: "var(--text)",
                        cursor: "pointer",
                        borderRadius: "var(--radius-sm)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 2,
                      }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span>🗄️</span>
                        <span>{profile.name}</span>
                      </span>
                      {profile.isDefault && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: "2px 6px",
                            background: "var(--primary)",
                            color: "var(--primary-foreground)",
                            borderRadius: 4,
                          }}
                        >
                          ✓
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>

              <div
                style={{
                  borderTop: "1px solid var(--border)",
                  padding: 4,
                }}
              >
                <button
                  type="button"
                  onClick={handleNewProfile}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    fontSize: 13,
                    textAlign: "left",
                    borderWidth: 0,
                    background: "transparent",
                    color: "var(--primary)",
                    cursor: "pointer",
                    borderRadius: "var(--radius-sm)",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span style={{ fontSize: 14 }}>➕</span>
                  <span>Add New Profile...</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <SupabaseProfileModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        onSave={handleProfileSaved}
      />
    </>
  );
}
