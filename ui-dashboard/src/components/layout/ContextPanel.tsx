import { ReactNode } from 'react';
import styles from './ContextPanel.module.css';

interface ContextSectionProps {
  title: string;
  children: ReactNode;
}

export function ContextSection({ title, children }: ContextSectionProps) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>{title}</div>
      {children}
    </div>
  );
}

interface ContextRowProps {
  label: string;
  value: ReactNode;
}

export function ContextRow({ label, value }: ContextRowProps) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{value}</span>
    </div>
  );
}

interface ContextPanelProps {
  children: ReactNode;
}

export function ContextPanel({ children }: ContextPanelProps) {
  return <aside className={styles.panel}>{children}</aside>;
}
