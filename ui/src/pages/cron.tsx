import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Skeleton } from "@/components/ui/skeleton";
import { useRPCQuery, useRPC } from "@/hooks";

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  status: "idle" | "running" | "error";
  lastRun?: string;
  nextRun?: string;
}

export function CronPage() {
  const { data, isLoading, refetch } = useRPCQuery<{ jobs: CronJob[] }>(
    "cron.list",
    {},
  );
  const rpc = useRPC();
  const [editDialog, setEditDialog] = useState(false);
  const [editJob, setEditJob] = useState<Partial<CronJob>>({});

  const toggleJob = async (id: string, enabled: boolean) => {
    await rpc("cron.update", { id, enabled });
    refetch();
  };

  const runJob = async (id: string) => {
    await rpc("cron.run", { id });
    refetch();
  };

  const saveJob = async () => {
    if (editJob.id) {
      await rpc("cron.update", editJob);
    } else {
      await rpc("cron.add", editJob);
    }
    setEditDialog(false);
    refetch();
  };

  const deleteJob = async (id: string) => {
    await rpc("cron.remove", { id });
    refetch();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Cron Jobs</h1>
        <Button
          onClick={() => {
            setEditJob({});
            setEditDialog(true);
          }}
        >
          Add Job
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead>Next Run</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.jobs.map((job) => (
              <TableRow key={job.id}>
                <TableCell>{job.name}</TableCell>
                <TableCell className="font-mono text-sm">
                  {job.schedule}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      job.status === "running"
                        ? "default"
                        : job.status === "error"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {job.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Switch
                    checked={job.enabled}
                    onCheckedChange={(v) => toggleJob(job.id, v)}
                  />
                </TableCell>
                <TableCell>
                  {job.nextRun ? new Date(job.nextRun).toLocaleString() : "-"}
                </TableCell>
                <TableCell className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runJob(job.id)}
                  >
                    Run
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditJob(job);
                      setEditDialog(true);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => deleteJob(job.id)}
                  >
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {data?.jobs && data.jobs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Run History</CardTitle>
          </CardHeader>
          <CardContent>
            <RunHistory rpc={rpc} jobs={data.jobs} />
          </CardContent>
        </Card>
      )}

      <Dialog open={editDialog} onOpenChange={setEditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editJob.id ? "Edit Job" : "Add Job"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <Input
              placeholder="Job name"
              value={editJob.name ?? ""}
              onChange={(e) => setEditJob({ ...editJob, name: e.target.value })}
            />
            <Input
              placeholder="Cron schedule (e.g. 0 * * * *)"
              value={editJob.schedule ?? ""}
              onChange={(e) =>
                setEditJob({ ...editJob, schedule: e.target.value })
              }
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditDialog(false)}>
                Cancel
              </Button>
              <Button onClick={saveJob}>Save</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RunHistory({
  rpc,
  jobs,
}: {
  rpc: ReturnType<typeof useRPC>;
  jobs: CronJob[];
}) {
  const [runs, setRuns] = useState<
    Record<
      string,
      { id: string; status: string; startedAt: string; finishedAt?: string }[]
    >
  >({});

  const loadRuns = async (jobId: string) => {
    const result = await rpc<{
      runs: {
        id: string;
        status: string;
        startedAt: string;
        finishedAt?: string;
      }[];
    }>("cron.runs", { id: jobId });
    setRuns((prev) => ({ ...prev, [jobId]: result.runs }));
  };

  return (
    <Accordion multiple>
      {jobs.map((job) => (
        <AccordionItem key={job.id} value={job.id}>
          <AccordionTrigger
            onClick={() => {
              if (!runs[job.id]) loadRuns(job.id);
            }}
          >
            {job.name}
          </AccordionTrigger>
          <AccordionContent>
            {runs[job.id] ? (
              <div className="space-y-1">
                {runs[job.id]!.map((run) => (
                  <div key={run.id} className="flex items-center gap-2 text-sm">
                    <Badge
                      variant={
                        run.status === "success" ? "default" : "destructive"
                      }
                    >
                      {run.status}
                    </Badge>
                    <span>{new Date(run.startedAt).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            ) : (
              <Skeleton className="h-8 w-full" />
            )}
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
