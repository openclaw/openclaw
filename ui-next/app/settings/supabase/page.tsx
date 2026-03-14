"use client";

import { useState, useEffect } from "react";
import {
  getSupabaseInstances,
  saveSupabaseInstance,
  deleteSupabaseInstance,
  setDefaultSupabaseInstance,
  testSupabaseConnection,
  type SupabaseInstanceConfig,
} from "@/lib/supabase-config";
import { useGateway } from "@/lib/use-gateway";

export default function SupabaseSettingsPage() {
  const { request } = useGateway();
  const [instances, setInstances] = useState<SupabaseInstanceConfig[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});
  const [isLoading, setIsLoading] = useState(true);
  
  const [formData, setFormData] = useState({
    name: "",
    url: "",
    key: "",
    schema: "public",
  });

  // Load existing instances
  useEffect(() => {
    loadInstances();
  }, []);

  const loadInstances = async () => {
    setIsLoading(true);
    try {
      const data = await getSupabaseInstances(request);
      setInstances(data);
    } catch (error) {
      console.error("Failed to load instances:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!formData.name || !formData.url || !formData.key) {
      return;
    }

    try {
      await saveSupabaseInstance(request, {
        id: editingId || formData.name,
        name: formData.name,
        url: formData.url,
        key: formData.key,
        schema: formData.schema,
      });

      setFormData({ name: "", url: "", key: "", schema: "public" });
      setEditingId(null);
      loadInstances();
    } catch (error) {
      console.error("Failed to save instance:", error);
    }
  };

  const handleEdit = (instance: SupabaseInstanceConfig) => {
    setEditingId(instance.id);
    setFormData({
      name: instance.name,
      url: instance.url,
      key: instance.key,
      schema: instance.schema || "public",
    });
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Are you sure you want to delete "${id}"?`)) {
      return;
    }

    try {
      await deleteSupabaseInstance(request, id);
      setTestResults((prev) => {
        const updated = { ...prev };
        delete updated[id];
        return updated;
      });
      loadInstances();
    } catch (error) {
      console.error("Failed to delete instance:", error);
    }
  };

  const handleTestConnection = async (instance: SupabaseInstanceConfig) => {
    setTestingId(instance.id);
    try {
      const result = await testSupabaseConnection(request, instance);
      setTestResults({
        ...testResults,
        [instance.id]: result,
      });
    } catch (error) {
      setTestResults({
        ...testResults,
        [instance.id]: {
          success: false,
          message: error instanceof Error ? error.message : "Unknown error",
        },
      });
    } finally {
      setTestingId(null);
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await setDefaultSupabaseInstance(request, id);
      loadInstances();
    } catch (error) {
      console.error("Failed to set default instance:", error);
    }
  };

  const handleCancel = () => {
    setEditingId(null);
    setFormData({ name: "", url: "", key: "", schema: "public" });
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Supabase Instances</h1>
      
      {/* Add/Edit Form */}
      <div className="bg-card border rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">
          {editingId ? "Edit Instance" : "Add New Instance"}
        </h2>
        
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              Profile Name *
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="production, staging, development..."
              className="w-full px-3 py-2 border rounded-md bg-background"
              disabled={!!editingId}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Project URL *
            </label>
            <input
              type="url"
              value={formData.url}
              onChange={(e) => setFormData({ ...formData, url: e.target.value })}
              placeholder="https://xxxxx.supabase.co"
              className="w-full px-3 py-2 border rounded-md bg-background"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Service Role Key *
            </label>
            <input
              type="password"
              value={formData.key}
              onChange={(e) => setFormData({ ...formData, key: e.target.value })}
              placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
              className="w-full px-3 py-2 border rounded-md bg-background"
            />
            <p className="text-xs text-muted mt-1">
              ⚠️ Use service_role key (not anon key) for backend operations
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Schema
            </label>
            <input
              type="text"
              value={formData.schema}
              onChange={(e) => setFormData({ ...formData, schema: e.target.value })}
              placeholder="public"
              className="w-full px-3 py-2 border rounded-md bg-background"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={!formData.name || !formData.url || !formData.key}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md disabled:opacity-50 hover:opacity-90"
            >
              {editingId ? "Save Changes" : "Add Instance"}
            </button>
            {editingId && (
              <button
                onClick={handleCancel}
                className="px-4 py-2 border rounded-md hover:bg-muted"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Instances List */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Configured Instances</h2>
        
        {isLoading ? (
          <div className="text-center py-8 text-muted">
            Loading instances...
          </div>
        ) : instances.length === 0 ? (
          <div className="text-center py-8 text-muted">
            No Supabase instances configured yet.
          </div>
        ) : (
          instances.map((instance) => (
            <div
              key={instance.id}
              className="bg-card border rounded-lg p-4"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="font-semibold">{instance.name}</h3>
                    {instance.isDefault && (
                      <span className="text-xs bg-primary text-primary-foreground px-2 py-0.5 rounded">
                        Default
                      </span>
                    )}
                  </div>
                  
                  <div className="text-sm text-muted space-y-1">
                    <p>URL: {instance.url}</p>
                    <p>Schema: {instance.schema || "public"}</p>
                  </div>

                  {/* Test Result */}
                  {testResults[instance.id] && (
                    <div
                      className={`mt-2 text-sm ${
                        testResults[instance.id].success
                          ? "text-green-600"
                          : "text-red-600"
                      }`}
                    >
                      {testResults[instance.id].success ? (
                        <span>✅ Connection successful!</span>
                      ) : (
                        <span>❌ {testResults[instance.id].message}</span>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => handleTestConnection(instance)}
                    disabled={testingId === instance.id}
                    className="px-3 py-1 text-sm border rounded-md hover:bg-muted disabled:opacity-50"
                  >
                    {testingId === instance.id ? "Testing..." : "Test Connection"}
                  </button>
                  
                  {!instance.isDefault && (
                    <button
                      onClick={() => handleSetDefault(instance.id)}
                      className="px-3 py-1 text-sm border rounded-md hover:bg-muted"
                    >
                      Set Default
                    </button>
                  )}
                  
                  <button
                    onClick={() => handleEdit(instance)}
                    className="px-3 py-1 text-sm border rounded-md hover:bg-muted"
                  >
                    Edit
                  </button>
                  
                  <button
                    onClick={() => handleDelete(instance.id)}
                    className="px-3 py-1 text-sm border rounded-md hover:bg-red-100 text-red-600"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
