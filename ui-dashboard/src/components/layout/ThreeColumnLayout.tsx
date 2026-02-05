import { ReactNode } from 'react';
import styles from './ThreeColumnLayout.module.css';

interface ThreeColumnLayoutProps {
  sidebar?: ReactNode;
  main: ReactNode;
  context?: ReactNode;
}

export function ThreeColumnLayout({ sidebar, main, context }: ThreeColumnLayoutProps) {
  return (
    <div className={styles.layout}>
      {sidebar}
      <main className={styles.main}>{main}</main>
      {context}
    </div>
  );
}
