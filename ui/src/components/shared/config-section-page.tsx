import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { useRPCQuery, useRPC } from "@/hooks";

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object")
      return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function setByPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const keys = path.split(".");
  const result = structuredClone(obj);
  let current: Record<string, unknown> = result;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (!current[k] || typeof current[k] !== "object") {
      current[k] = {};
    }
    current = current[k] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
  return result;
}

interface ConfigField {
  key: string;
  label: string;
  type: "text" | "number" | "boolean";
}

interface ConfigSectionPageProps {
  title: string;
  section: string;
  fields: ConfigField[];
}

export function ConfigSectionPage({
  title,
  section,
  fields,
}: ConfigSectionPageProps) {
  const { data, isLoading } = useRPCQuery<{
    snapshot: Record<string, unknown>;
  }>("config.get");
  const rpc = useRPC();
  const [values, setValues] = useState<Record<string, unknown>>({});

  const sectionData =
    (data?.snapshot?.[section] as Record<string, unknown>) ?? {};

  useEffect(() => {
    setValues(sectionData);
  }, [JSON.stringify(sectionData)]);

  const save = async () => {
    try {
      await rpc("config.patch", { [section]: values });
      toast.success("Settings saved");
    } catch (e) {
      toast.error(
        `Failed: ${e instanceof Error ? e.message : "Unknown error"}`,
      );
    }
  };

  if (isLoading) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{title}</h1>
      <Card>
        <CardContent className="pt-6 space-y-4">
          {fields.map((field) => (
            <div key={field.key} className="flex items-center justify-between">
              <label className="text-sm font-medium">{field.label}</label>
              {field.type === "boolean" ? (
                <Switch
                  checked={Boolean(getByPath(values, field.key))}
                  onCheckedChange={(v) =>
                    setValues(setByPath(values, field.key, v))
                  }
                />
              ) : (
                <Input
                  type={field.type}
                  className="w-64"
                  value={String(getByPath(values, field.key) ?? "")}
                  onChange={(e) =>
                    setValues(
                      setByPath(
                        values,
                        field.key,
                        field.type === "number"
                          ? Number(e.target.value)
                          : e.target.value,
                      ),
                    )
                  }
                />
              )}
            </div>
          ))}
          <Button onClick={save}>Save</Button>
        </CardContent>
      </Card>
    </div>
  );
}
