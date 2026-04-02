import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTheme } from "@/hooks/use-theme";
import { useTranslation } from "react-i18next";

const locales = [
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Espanol" },
  { value: "pt-BR", label: "Portugues (BR)" },
  { value: "zh-CN", label: "Chinese (Simplified)" },
  { value: "zh-TW", label: "Chinese (Traditional)" },
];

export function AppearancePage() {
  const { theme, setTheme, effectiveTheme } = useTheme();
  const { i18n } = useTranslation();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Appearance</h1>

      <Card>
        <CardHeader>
          <CardTitle>Theme</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <span>Dark mode</span>
            <Switch
              checked={effectiveTheme === "dark"}
              onCheckedChange={(checked) =>
                setTheme(checked ? "dark" : "light")
              }
            />
          </div>
          <div className="flex items-center justify-between">
            <span>Use system theme</span>
            <Switch
              checked={theme === "system"}
              onCheckedChange={(checked) =>
                setTheme(checked ? "system" : effectiveTheme)
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Language</CardTitle>
        </CardHeader>
        <CardContent>
          <Select
            value={i18n.language}
            onValueChange={(v) => {
              if (v) i18n.changeLanguage(v);
            }}
          >
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {locales.map((locale) => (
                <SelectItem key={locale.value} value={locale.value}>
                  {locale.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
    </div>
  );
}
