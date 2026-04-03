import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useRPCQuery } from "@/hooks";

export function UsagePage() {
  const [dateRange, setDateRange] = useState<{ start: Date; end: Date }>({
    start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    end: new Date(),
  });

  const { data: usage, isLoading } = useRPCQuery<{
    sessions: { key: string; tokens: number; cost: number }[];
    total: { tokens: number; cost: number };
    daily: { date: string; tokens: number; cost: number }[];
  }>("usage.status", {
    start: dateRange.start.toISOString(),
    end: dateRange.end.toISOString(),
  });

  const { data: cost } = useRPCQuery<{
    total: number;
    currency: string;
  }>("usage.cost");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Usage</h1>
        <Popover>
          <PopoverTrigger
            render={
              <Button variant="outline">
                {dateRange.start.toLocaleDateString()} -{" "}
                {dateRange.end.toLocaleDateString()}
              </Button>
            }
          />
          <PopoverContent className="w-auto p-0" align="end">
            <Calendar
              mode="range"
              selected={{ from: dateRange.start, to: dateRange.end }}
              onSelect={(range) => {
                if (range?.from && range?.to) {
                  setDateRange({ start: range.from, end: range.to });
                }
              }}
            />
          </PopoverContent>
        </Popover>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">
                  Total Tokens
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {usage?.total.tokens.toLocaleString() ?? 0}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">
                  Total Cost
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  ${(cost?.total ?? usage?.total.cost ?? 0).toFixed(2)}
                </p>
              </CardContent>
            </Card>
          </div>

          {usage?.daily && usage.daily.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Usage Over Time</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={usage.daily}>
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Line
                      type="monotone"
                      dataKey="tokens"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {usage?.sessions && (
            <Card>
              <CardHeader>
                <CardTitle>Breakdown by Session</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Session</TableHead>
                      <TableHead>Tokens</TableHead>
                      <TableHead>Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {usage.sessions.map((s) => (
                      <TableRow key={s.key}>
                        <TableCell className="font-mono text-sm">
                          {s.key.slice(0, 12)}
                        </TableCell>
                        <TableCell>{s.tokens.toLocaleString()}</TableCell>
                        <TableCell>${s.cost.toFixed(4)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
