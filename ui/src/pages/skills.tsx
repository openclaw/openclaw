import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRPCQuery, useRPC } from "@/hooks";

interface Skill {
  name: string;
  version?: string;
  status: "installed" | "available" | "update-available" | "error";
  description?: string;
}

export function SkillsPage() {
  const { data, isLoading, refetch } = useRPCQuery<{ skills: Skill[] }>(
    "skills.status",
  );
  const rpc = useRPC();

  const installSkill = async (name: string) => {
    await rpc("skills.install", { name });
    refetch();
  };

  const updateSkill = async (name: string) => {
    await rpc("skills.update", { name });
    refetch();
  };

  const statusVariant = (status: string) => {
    switch (status) {
      case "installed":
        return "default" as const;
      case "available":
        return "secondary" as const;
      case "update-available":
        return "outline" as const;
      case "error":
        return "destructive" as const;
      default:
        return "outline" as const;
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Skills</h1>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data?.skills.map((skill) => (
            <Card key={skill.name}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{skill.name}</CardTitle>
                  <Badge variant={statusVariant(skill.status)}>
                    {skill.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {skill.description && (
                  <p className="text-sm text-muted-foreground">
                    {skill.description}
                  </p>
                )}
                {skill.version && (
                  <p className="text-xs text-muted-foreground">
                    v{skill.version}
                  </p>
                )}
                {skill.status === "available" && (
                  <Button size="sm" onClick={() => installSkill(skill.name)}>
                    Install
                  </Button>
                )}
                {skill.status === "update-available" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => updateSkill(skill.name)}
                  >
                    Update
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
